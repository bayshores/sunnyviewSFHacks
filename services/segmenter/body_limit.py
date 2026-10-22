"""ASGI middleware that rejects oversized request bodies with HTTP 413.

Checks the declared ``Content-Length`` first, then counts the bytes actually
streamed (covers chunked uploads and lying headers). The body is buffered up to
the limit and replayed to the app, which would buffer it anyway to parse JSON.
"""

from typing import Callable, List, Optional

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

TOO_LARGE_DETAIL = "Request body too large"


def _declared_length(scope: Scope) -> Optional[int]:
    for name, value in scope.get("headers") or []:
        if name.lower() == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


def _replay(messages: List[Message], receive: Receive) -> Receive:
    pending = iter(messages)

    async def replay_receive() -> Message:
        message = next(pending, None)
        return message if message is not None else await receive()

    return replay_receive


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: Callable[[], int]) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes()
        declared = _declared_length(scope)
        if declared is not None and declared > limit:
            await self._reject(scope, receive, send)
            return

        messages: List[Message] = []
        total = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] != "http.request":  # e.g. http.disconnect
                break
            total += len(message.get("body", b""))
            if total > limit:
                await self._reject(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        await self.app(scope, _replay(messages, receive), send)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse({"detail": TOO_LARGE_DETAIL}, status_code=413)
        await response(scope, receive, send)
