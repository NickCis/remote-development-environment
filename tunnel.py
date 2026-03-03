#!/usr/bin/env python3
"""
Port forwarding client: listen on local ports and forward TCP over WebSocket to the server.
Usage: python tunnel.py [options] [host:port] port1 [port2 ...]
  host:port default: localhost:3847. Remaining args are local ports to listen on.
  --token TOKEN  Auth token; use --token=VAL or TERMINAL_TOKEN; required if server uses auth.
Example: python tunnel.py 8080 9090
         python tunnel.py 192.168.1.1:3847 8080
         python tunnel.py --token <token> 8080
"""
import asyncio
import base64
import hashlib
import os
import struct
import sys
from urllib.parse import quote


def parse_args():
    args = sys.argv[1:]
    if not args:
        print("Usage: python tunnel.py [options] [host:port] port1 [port2 ...]", file=sys.stderr)
        sys.exit(1)
    token = os.environ.get("TERMINAL_TOKEN", "")
    new_args = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--token":
            if i + 1 < len(args):
                token = args[i + 1]
                i += 2
                continue
            i += 1
            continue
        if a.startswith("--token="):
            token = a[8:]
            i += 1
            continue
        new_args.append(a)
        i += 1
    args = new_args
    host = "localhost"
    port = 3847
    if args and (":" in args[0] or "." in args[0] or args[0].isalpha()):
        host_port = args[0]
        args = args[1:]
        if ":" in host_port:
            host, p = host_port.rsplit(":", 1)
            if p.isdigit():
                port = int(p)
        else:
            host = host_port
    if not args:
        print("At least one port to forward is required", file=sys.stderr)
        sys.exit(1)
    ports = [int(p) for p in args if p.isdigit()]
    if not ports:
        print("At least one port to forward is required", file=sys.stderr)
        sys.exit(1)
    return host, port, ports, token


# --- Minimal WebSocket client (stdlib) ---
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def make_ws_key():
    return base64.b64encode(os.urandom(16)).decode("ascii")


def build_handshake(key):
    return (
        "GET /tunnel HTTP/1.1\r\n"
        "Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ).format(host="tunnel", key=key).encode("ascii")


def encode_ws_binary(payload: bytes) -> bytes:
    mask_key = os.urandom(4)
    length = len(payload)
    if length < 126:
        hdr = struct.pack(">BB", 0x82, 0x80 | length)
    elif length < 65536:
        hdr = struct.pack(">BBH", 0x82, 0x80 | 126, length)
    else:
        hdr = struct.pack(">BBQ", 0x82, 0x80 | 127, length)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return hdr + mask_key + masked


def parse_ws_frame(data: bytes):
    if len(data) < 2:
        return None, data
    opcode = data[0] & 0x0F
    masked = (data[1] & 0x80) != 0
    length = data[1] & 0x7F
    pos = 2
    if length == 126:
        if len(data) < 4:
            return None, data
        length = struct.unpack(">H", data[2:4])[0]
        pos = 4
    elif length == 127:
        if len(data) < 10:
            return None, data
        length = struct.unpack(">Q", data[2:10])[0]
        pos = 10
    if masked:
        if len(data) < pos + 4 + length:
            return None, data
        mask = data[pos : pos + 4]
        pos += 4
        payload = bytes(data[pos + i] ^ mask[i % 4] for i in range(length))
    else:
        if len(data) < pos + length:
            return None, data
        payload = bytes(data[pos : pos + length])
    pos += length
    return (opcode, payload), data[pos:]


# --- Tunnel protocol: type (1B), channel_id (4B BE), [port 2B | length 2B + payload] ---
TYPE_OPEN = 0
TYPE_DATA = 1
TYPE_CLOSE = 2


def build_open(channel_id: int, port: int) -> bytes:
    return struct.pack(">BIH", TYPE_OPEN, channel_id, port)


def build_data(channel_id: int, payload: bytes) -> bytes:
    if len(payload) > 65535:
        raise ValueError("payload too long")
    return struct.pack(">BIH", TYPE_DATA, channel_id, len(payload)) + payload


def build_close(channel_id: int) -> bytes:
    return struct.pack(">BI", TYPE_CLOSE, channel_id)


def parse_message(data: bytes):
    if len(data) < 5:
        return None, data
    msg_type = data[0]
    channel_id = struct.unpack(">I", data[1:5])[0]
    rest = data[5:]
    if msg_type == TYPE_OPEN:
        return None, data
    if msg_type == TYPE_DATA:
        if len(rest) < 2:
            return None, data
        length = struct.unpack(">H", rest[0:2])[0]
        if len(rest) < 2 + length:
            return None, data
        return (msg_type, channel_id, rest[2 : 2 + length]), rest[2 + length :]
    if msg_type == TYPE_CLOSE:
        return (msg_type, channel_id, None), rest
    return None, data


async def run_tunnel(host: str, port: int, ports: list, token: str = ""):
    next_channel_id = 1
    channels = {}
    ws_reader = None
    ws_writer = None
    ws_buffer = b""
    loop = asyncio.get_event_loop()

    async def connect_ws():
        nonlocal ws_reader, ws_writer
        key_b64 = make_ws_key()
        key_bin = (key_b64 + WS_MAGIC).encode("ascii")
        accept = hashlib.sha1(key_bin).digest()
        accept_b64 = base64.b64encode(accept).decode("ascii")
        path = "/tunnel"
        if token:
            path += "?token=" + quote(token, safe="")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key_b64}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
        )
        if token:
            req += f"Authorization: Bearer {token}\r\n"
        req += "\r\n"
        reader, writer = await asyncio.open_connection(host, port)
        writer.write(req.encode("ascii"))
        await writer.drain()
        line = await reader.readline()
        if not line.startswith(b"HTTP/1.1 101"):
            writer.close()
            await writer.wait_closed()
            raise ConnectionError("WebSocket handshake failed")
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n"):
                break
        ws_reader = reader
        ws_writer = writer
        print(f"Connected to {host}:{port}", file=sys.stderr)

    def send_ws(data: bytes):
        if ws_writer is None or ws_writer.is_closing():
            return
        ws_writer.write(encode_ws_binary(data))
        loop.call_soon_threadsafe(lambda: None)

    async def drain_ws():
        if ws_writer:
            await ws_writer.drain()

    async def ws_receive_task():
        nonlocal ws_buffer
        while ws_reader and not ws_reader.at_eof():
            try:
                chunk = await ws_reader.read(65536)
                if not chunk:
                    break
                ws_buffer += chunk
                while True:
                    frame, remainder = parse_ws_frame(ws_buffer)
                    if frame is None:
                        break
                    ws_buffer = remainder
                    opcode, payload = frame
                    if opcode == 0x08:
                        return
                    if opcode != 0x02:
                        continue
                    buf = payload
                    while buf:
                        msg, buf = parse_message(buf)
                        if msg is None:
                            break
                        if msg[0] == TYPE_DATA:
                            _, ch_id, pl = msg
                            entry = channels.get(ch_id)
                            if entry and not entry[1].is_closing():
                                entry[1].write(pl)
                                try:
                                    await entry[1].drain()
                                except Exception:
                                    pass
                        elif msg[0] == TYPE_CLOSE:
                            _, ch_id, _ = msg
                            entry = channels.pop(ch_id, None)
                            if entry:
                                entry[1].close()
                                try:
                                    await entry[1].wait_closed()
                                except Exception:
                                    pass
            except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
                break
            except Exception:
                break

    async def handle_local(local_reader, local_writer, listen_port: int):
        nonlocal next_channel_id
        ch_id = next_channel_id
        next_channel_id += 1
        if next_channel_id >= 2**32:
            next_channel_id = 1
        channels[ch_id] = (local_reader, local_writer)
        send_ws(build_open(ch_id, listen_port))
        await drain_ws()

        async def read_local():
            try:
                while True:
                    data = await local_reader.read(65536)
                    if not data:
                        break
                    send_ws(build_data(ch_id, data))
                    await drain_ws()
            except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
                pass
            finally:
                if ch_id in channels:
                    del channels[ch_id]
                    send_ws(build_close(ch_id))
                    await drain_ws()
                local_writer.close()
                try:
                    await local_writer.wait_closed()
                except Exception:
                    pass

        asyncio.create_task(read_local())

    async def serve_port(p: int):
        server = await asyncio.start_server(
            lambda r, w: handle_local(r, w, p), "0.0.0.0", p
        )
        print(f"Listening on 0.0.0.0:{p}", file=sys.stderr)
        async with server:
            await server.serve_forever()

    backoff = 1.0
    max_backoff = 30.0
    while True:
        server_tasks = []
        try:
            await connect_ws()
            backoff = 1.0
            for p in ports:
                server_tasks.append(asyncio.create_task(serve_port(p)))
            await ws_receive_task()
        except Exception as e:
            print(f"Disconnected: {e}", file=sys.stderr)
            for entry in list(channels.values()):
                entry[1].close()
                try:
                    await entry[1].wait_closed()
                except Exception:
                    pass
            channels.clear()
        for t in server_tasks:
            t.cancel()
        await asyncio.gather(*server_tasks, return_exceptions=True)
        if ws_writer:
            try:
                ws_writer.close()
                await ws_writer.wait_closed()
            except Exception:
                pass
            ws_writer = None
        ws_reader = None
        print(f"Reconnecting in {backoff:.0f}s...", file=sys.stderr)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)


def main():
    host, port, ports, token = parse_args()
    asyncio.run(run_tunnel(host, port, ports, token))


if __name__ == "__main__":
    main()
