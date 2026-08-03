"""The seam between Wren and anything watching her.

Wren narrates herself to the terminal already. This sends the same information
somewhere a UI can read it, without changing what the terminal sees and without
Wren having to know whether anyone is listening.

Two file descriptors, opened by the parent process and named in the environment:

    WREN_EVENT_FD     events out, one JSON object per line   (Electron opens 3)
    WREN_COMMAND_FD   commands in, one JSON object per line  (Electron opens 4)

Not stdout. Wren's terminal output is for a person and is full of box-drawing
characters and ANSI colour; interleaving a machine stream into it would corrupt
both, and any stray ``print`` added later would corrupt the events. Separate
descriptors mean the two can never collide.

The environment variables are not decoration, and this module must never go
looking for an open descriptor on its own. An earlier version checked whether
fd 3 happened to be open and used it if so — which is true far more often than
you would think, because a shell pipeline hands its children all sorts of
descriptors. Wren duly wrote JSON into a handle that belonged to Metal, and the
GPU stopped being able to load kernels. A descriptor is only ours if the parent
says it is.

With the variables unset — which is every time you run ``python wren_v1.py``
yourself — every function here is a no-op. That is the property the whole
refactor rests on: instrumenting Wren must not change how Wren behaves when
nobody has attached to her.
"""

import json
import os
import sys
import threading
import time

# Session time, matching the ``t`` field the UI's fixture files carry. Absolute
# seconds since Wren started, so a recorded session and a hand-written fixture
# are the same kind of thing.
_origin = time.monotonic()

_out = None
_lock = threading.Lock()  # respond() runs on its own thread; both ends emit.


def _declared(name):
    """The descriptor the parent named, or None. Never a guess."""
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        fd = int(raw)
    except ValueError:
        return None
    try:
        os.fstat(fd)  # Named but not actually open is a parent-side bug.
    except OSError:
        return None
    return fd


def _attach():
    """Open the event descriptor, if we were given one. Absence is the norm."""
    global _out
    fd = _declared("WREN_EVENT_FD")
    if fd is None:
        return  # Nobody is listening. Everything below turns into a no-op.
    try:
        _out = os.fdopen(fd, "w", buffering=1, encoding="utf-8")
    except OSError:
        _out = None


_attach()


def attached():
    return _out is not None


def emit(kind, **fields):
    """One record. Never raises — a dead reader must not take Wren down."""
    if _out is None:
        return
    record = {"t": round(time.monotonic() - _origin, 3), "kind": kind}
    record.update(fields)
    line = json.dumps(record, ensure_ascii=False, default=str)
    with _lock:
        try:
            _out.write(line + "\n")
        except (BrokenPipeError, ValueError, OSError):
            # The UI quit while Wren kept running. Stop trying; she is fine.
            _detach()


def _detach():
    global _out
    try:
        _out.close()
    except Exception:
        pass
    _out = None


def stage(name, status, **fields):
    """One of the six subsystems loading. The UI's boot ring runs on these."""
    emit("stage", name=name, status=status, **fields)


class _Stage:
    """Bracket a load so the ``done``/``error`` pair can never be forgotten.

    A stage that raises is reported and swallowed: one missing model file should
    cost you that capability, not the whole process. The caller decides what a
    failure means by checking ``ok``.
    """

    def __init__(self, name, note=None):
        self.name = name
        self.note = note
        self.ok = False
        self.error = None

    def __enter__(self):
        if self.note:
            stage(self.name, "start", note=self.note)
        else:
            stage(self.name, "start")
        return self

    def __exit__(self, kind, value, traceback):
        if value is None:
            self.ok = True
            stage(self.name, "done")
            return False
        self.error = value
        stage(self.name, "error", message=f"{type(value).__name__}: {value}")
        return True  # Handled. The load carries on around the casualty.


def loading(name, note=None):
    return _Stage(name, note)


# ── Commands ──────────────────────────────────────────────────────────────────
# Read on their own thread and turned into flags. Nothing here touches the audio
# path: the mic loop reads a boolean, and anything needing to happen immediately
# happens through the handler the caller registers.


class Commands:
    def __init__(self):
        self.muted = False
        self._handler = None

    def on(self, handler):
        self._handler = handler

    def _apply(self, record):
        kind = record.get("kind")
        if kind == "mute":
            # `on` is optional so the UI can either toggle or set outright; the
            # button sends a bare toggle and lets Wren decide what that means.
            wanted = record.get("on")
            self.muted = (not self.muted) if wanted is None else bool(wanted)
        if self._handler is not None:
            try:
                self._handler(record)
            except Exception as error:  # A bad command must not kill the reader
                print(f"  ! command failed: {error}", file=sys.stderr)


commands = Commands()


def _read_commands(fd):
    try:
        stream = os.fdopen(fd, "r", encoding="utf-8")
    except OSError:
        return
    with stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            commands._apply(record)


def listen():
    """Start reading commands, if the parent named a descriptor for them."""
    fd = _declared("WREN_COMMAND_FD")
    if fd is None:
        return
    thread = threading.Thread(target=_read_commands, args=(fd,),
                              name="commands", daemon=True)
    thread.start()
