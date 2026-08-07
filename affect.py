"""Wren's emotional state and homeostatic drives.

Two continuous variables from Russell's circumplex model — Valence (how good
this feels, -1 to 1) and Arousal (how activated, 0 to 1) — plus five drives
that pull on them over time: cognitive Fatigue, Curiosity, Social trust,
Boredom, and Existential security. Left alone, valence and arousal decay
exponentially back to baseline; the drives accumulate from what Wren has been
doing (tokens generated, time idle, whether things have been going well) and
decay or reset on their own schedules. See
memory_instructions/wren_specs_02_affect_and_emotions.md for the philosophy
and memory_instructions/wren_specs_09_affect_engine_implementation_plan.md
for the maths this file implements.

Infrastructure only: nothing here is wired into the app yet, the same as
memory.py. There is no appraisal signal to feed it (the "fast amygdala"
pass in spec 08 doesn't exist) and no UI surface to read it (the brain
view's emotion layer is drawn dashed and never lights — see DESIGN.md).
Wiring this into wren_v1.py's responder loop belongs to whichever change
actually adds one of those two things.

Thread-safety is real, not aspirational, because the eventual caller shape is
already visible in wren_v1.py: the responder thread would drive fatigue and
appraisal deltas while the main thread reads telemetry and hyperparameters
concurrently — the same split events.py already guards with a lock around
`emit()`. An RLock (not a plain Lock) is used deliberately: `tick()` is a
single logical update that calls the individual `update_*` methods, and each
of those takes the lock itself too, so the outer call has to be reentrant on
the same thread or it would deadlock itself.
"""

import math
import threading
import time
from typing import Any, Dict, Optional


class AffectEngine:
    def __init__(self, v_base: float = 0.0, a_base: float = 0.2):
        self._lock = threading.RLock()

        self.v_base = v_base
        self.a_base = a_base
        self.valence = v_base
        self.arousal = a_base

        # Drives. Curiosity and social trust start at their midpoint rather
        # than 0 — a freshly-started Wren is neither incurious nor
        # distrustful, just unopinionated. Existential security starts at
        # its ceiling: nothing has gone wrong yet.
        self.fatigue = 0.0
        self.curiosity = 0.5
        self.social_trust = 0.5
        self.boredom = 0.0
        self.existential_security = 1.0

        self.last_update_time = time.time()
        # What apply_deltas was last called for — not read by anything yet,
        # but the parameter would otherwise be accepted and silently
        # dropped, which is worse than a field nothing consumes yet.
        self.last_trigger: Optional[str] = None

    @staticmethod
    def _clamp(value: float, low: float, high: float) -> float:
        return max(low, min(high, value))

    # ── Emotional core ──────────────────────────────────────────────────────

    def apply_deltas(self, v_delta: float, a_delta: float, trigger: str = "appraisal") -> None:
        """A discrete push on valence/arousal — something just happened."""
        with self._lock:
            self.valence = self._clamp(self.valence + v_delta, -1.0, 1.0)
            self.arousal = self._clamp(self.arousal + a_delta, 0.0, 1.0)
            self.last_trigger = trigger

    def decay_step(self, dt: float = None, lambda_v: float = 0.05, lambda_a: float = 0.08) -> None:
        """Relax valence/arousal back toward baseline over elapsed time `dt`.

        `dt=None` measures elapsed wall time itself since the last update —
        the normal case. An explicit `dt` is for `tick()`, which reads the
        clock once for the whole update and passes the same value to every
        method so they can't drift apart from each other.
        """
        with self._lock:
            now = time.time()
            if dt is None:
                dt = now - self.last_update_time
            self.last_update_time = now

            self.valence = self.v_base + (self.valence - self.v_base) * math.exp(-lambda_v * dt)
            self.arousal = self.a_base + (self.arousal - self.a_base) * math.exp(-lambda_a * dt)

    # ── Homeostatic drives ───────────────────────────────────────────────────

    def update_fatigue(self, tokens_generated: int, dt: float, gamma: float = 0.0005, lambda_f: float = 0.02) -> None:
        with self._lock:
            self.fatigue = self._clamp(self.fatigue + gamma * tokens_generated - lambda_f * dt, 0.0, 1.0)

    def update_curiosity(self, uncertainty: float, dt: float, alpha: float = 0.2, lambda_c: float = 0.03) -> None:
        with self._lock:
            self.curiosity = self._clamp(self.curiosity + alpha * uncertainty - lambda_c * dt, 0.0, 1.0)

    def update_social_trust(self, v_window_avg: float, eta: float = 0.05) -> None:
        with self._lock:
            self.social_trust = self._clamp(self.social_trust + eta * v_window_avg, 0.0, 1.0)

    def update_boredom(self, dt_idle: float, user_interacted: bool, beta: float = 0.01, delta: float = 0.4) -> None:
        with self._lock:
            if user_interacted:
                self.boredom = self._clamp(self.boredom - delta, 0.0, 1.0)
            else:
                self.boredom = self._clamp(self.boredom + beta * dt_idle, 0.0, 1.0)

    def update_existential_security(self, success_rate: float, error_rate: float, sigma: float = 0.1, omega: float = 0.3) -> None:
        with self._lock:
            self.existential_security = self._clamp(
                self.existential_security + sigma * success_rate - omega * error_rate, 0.0, 1.0)

    # ── Combined tick ────────────────────────────────────────────────────────

    def tick(self, tokens_generated: int = 0, uncertainty: float = 0.0,
             v_window_avg: Optional[float] = None, user_interacted: bool = False,
             success_rate: float = 0.0, error_rate: float = 0.0) -> float:
        """Advance every time-driven quantity by one elapsed wall-clock step.

        The individual `update_*`/`decay_step` methods above take `dt`
        explicitly and are the ones to reach for in a test, or anywhere the
        caller already has a specific elapsed time in hand. `tick()` is for
        the normal running case: it reads the clock exactly once and hands
        every method the *same* `dt`, so fatigue can't advance against a
        different clock than boredom just because they were ticked
        separately a few milliseconds apart. `v_window_avg` is optional
        because social trust only has something to update from once a
        window of turns exists; pass None to leave it untouched this tick.

        Returns the `dt` used, mostly so a caller (or the smoke test below)
        can print what elapsed.
        """
        with self._lock:
            now = time.time()
            dt = now - self.last_update_time
            self.decay_step(dt=dt)
            self.update_fatigue(tokens_generated, dt)
            self.update_curiosity(uncertainty, dt)
            self.update_boredom(dt, user_interacted)
            if v_window_avg is not None:
                self.update_social_trust(v_window_avg)
            self.update_existential_security(success_rate, error_rate)
            return dt

    # ── Reads ────────────────────────────────────────────────────────────────

    def get_dominant_drive(self) -> str:
        with self._lock:
            drives = {
                "cognitive_fatigue": self.fatigue,
                "curiosity": self.curiosity,
                "boredom": self.boredom,
                "low_existential_security": 1.0 - self.existential_security,
            }
            return max(drives, key=drives.get)

    def get_llm_hyperparameters(self) -> Dict[str, float]:
        """Map current affect onto generation knobs for llm.py.

        Not wired to llm.py yet — it hardcodes its own TEMPERATURE. This is
        the mapping that would replace that constant once there's a real
        appraisal signal driving valence/arousal in the first place.
        """
        with self._lock:
            temp = (0.7 + 0.3 * self.arousal - 0.2 * self.fatigue
                    + 0.1 * self.curiosity - 0.3 * (1.0 - self.existential_security))
            top_p = 0.9 + 0.08 * self.valence + 0.05 * self.curiosity
            return {
                "temperature": self._clamp(temp, 0.1, 1.2),
                "top_p": self._clamp(top_p, 0.7, 1.0),
                "presence_penalty": 0.1 if self.boredom > 0.6 else 0.0,
            }

    def get_state_telemetry(self) -> Dict[str, Any]:
        """A snapshot for logging/UI — matches the fd 3 shape spec 08 describes."""
        with self._lock:
            return {
                "valence": round(self.valence, 3),
                "arousal": round(self.arousal, 3),
                "fatigue": round(self.fatigue, 3),
                "curiosity": round(self.curiosity, 3),
                "social_trust": round(self.social_trust, 3),
                "boredom": round(self.boredom, 3),
                "existential_security": round(self.existential_security, 3),
                "dominant_drive": self.get_dominant_drive(),
            }


def main():
    """Smoke test — no framework in this repo, so this follows memory.py's
    pattern of a real `main()` you run directly and read the output of.
    """
    engine = AffectEngine()
    print("initial:", engine.get_state_telemetry())

    engine.apply_deltas(v_delta=0.4, a_delta=0.2, trigger="user praised a reply")
    print("after praise:", engine.get_state_telemetry())

    # A few ticks standing in for a busy, successful stretch of conversation:
    # tokens flowing, some uncertainty, no idle time, things going well.
    for _ in range(3):
        dt = engine.tick(tokens_generated=120, uncertainty=0.3, user_interacted=True,
                         success_rate=1.0, error_rate=0.0)
        print(f"tick (dt={dt:.4f}s):", engine.get_state_telemetry())

    # Then silence: boredom should climb, everything else should relax
    # toward baseline instead of being pushed further.
    engine.last_update_time -= 30  # simulate 30s idle without a real sleep
    dt = engine.tick(user_interacted=False)
    print(f"after 30s idle (dt={dt:.4f}s):", engine.get_state_telemetry())
    print("hyperparameters:", engine.get_llm_hyperparameters())

    # Concurrent read/write, to exercise the lock rather than just have one.
    def writer():
        for _ in range(200):
            engine.tick(tokens_generated=1, uncertainty=0.1)

    def reader():
        for _ in range(200):
            engine.get_state_telemetry()

    threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    print("after concurrent tick/read:", engine.get_state_telemetry())


if __name__ == "__main__":
    main()
