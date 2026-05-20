import socket
import unittest
from http.server import SimpleHTTPRequestHandler

import server


def reserve_wildcard_port_with_free_next():
    for _ in range(100):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        blocker.bind(("0.0.0.0", 0))
        blocked_port = blocker.getsockname()[1]

        if blocked_port >= 65535:
            blocker.close()
            continue

        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", blocked_port + 1))
        except OSError:
            blocker.close()
            probe.close()
            continue

        probe.close()
        blocker.listen(1)
        return blocker, blocked_port

    raise RuntimeError("could not find a suitable test port")


class PortSelectionTests(unittest.TestCase):
    def test_http_server_skips_wildcard_listener_on_requested_port(self):
        blocker, blocked_port = reserve_wildcard_port_with_free_next()
        try:
            http_server, active_port = server.create_http_server(
                "127.0.0.1",
                blocked_port,
                2,
                SimpleHTTPRequestHandler,
            )
            try:
                self.assertEqual(blocked_port + 1, active_port)
            finally:
                http_server.server_close()
        finally:
            blocker.close()


if __name__ == "__main__":
    unittest.main()
