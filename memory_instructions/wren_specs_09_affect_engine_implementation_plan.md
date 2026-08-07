# 09. Phase 1 Implementation Plan — The Affect Engine (`affect.py`)

This document is the explicit source of truth for implementing **`affect.py`** for Claude Code.

---

## 1. Architectural Objective
Implement `AffectEngine` in `affect.py` as a continuous, thread-safe state manager for Wren's emotional state ($V, A$) and five homeostatic drives ($F, C, S, B, E$).

---

## 2. Mathematical Specifications

### 2.1 Emotional State Space & Exponential Decay
* **Valence ($V \in [-1.0, 1.0]$):** Baseline $= 0.0$.
* **Arousal ($A \in [0.0, 1.0]$):** Baseline $= 0.2$.

$$V_t = V_{\text{baseline}} + (V_{t-1} - V_{\text{baseline}}) \cdot e^{-\lambda_v \Delta t}$$
$$A_t = A_{\text{baseline}} + (A_{t-1} - A_{\text{baseline}}) \cdot e^{-\lambda_a \Delta t}$$

$$\Delta \text{Clamping: } V_{\text{new}} = \text{clamp}(V + \Delta V, -1.0, 1.0), \quad A_{\text{new}} = \text{clamp}(A + \Delta A, 0.0, 1.0)$$

### 2.2 Homeostatic Drives
1. **Cognitive Fatigue ($F \in [0.0, 1.0]$):** $F_t = \text{clamp}(F_{t-1} + \gamma_{\text{work}} \cdot \Delta N_{\text{tokens}} - \lambda_{\text{fatigue}} \cdot \Delta t, 0.0, 1.0)$
2. **Curiosity ($C \in [0.0, 1.0]$):** $C_t = \text{clamp}(C_{t-1} + \alpha_{\text{novelty}} \cdot \text{Uncertainty} - \lambda_{\text{curiosity}} \cdot \Delta t, 0.0, 1.0)$
3. **Social Trust ($S \in [0.0, 1.0]$):** $S_t = \text{clamp}(S_{t-1} + \eta_{\text{trust}} \cdot \bar{V}_{\text{window}}, 0.0, 1.0)$
4. **Boredom ($B \in [0.0, 1.0]$):** $B_t = \text{clamp}(B_{t-1} + \beta_{\text{idle}} \cdot \Delta t_{\text{idle}} - \delta_{\text{interaction}} \cdot \text{UserTurn}, 0.0, 1.0)$
5. **Existential Security ($E \in [0.0, 1.0]$):** $E_t = \text{clamp}(E_{t-1} + \sigma_{\text{stability}} \cdot \text{SuccessRate} - \omega_{\text{fault}} \cdot \text{ErrorRate}, 0.0, 1.0)$

---

## 3. Class Specifications (`affect.py`)

```python
import math
import time
from typing import Dict, Any

class AffectEngine:
    def __init__(self, v_base: float = 0.0, a_base: float = 0.2):
        self.v_base = v_base
        self.a_base = a_base
        self.valence = v_base
        self.arousal = a_base
        
        # Drives
        self.fatigue = 0.0
        self.curiosity = 0.5
        self.social_trust = 0.5
        self.boredom = 0.0
        self.existential_security = 1.0
        self.last_update_time = time.time()

    def apply_deltas(self, v_delta: float, a_delta: float, trigger: str = "appraisal") -> None:
        self.valence = max(-1.0, min(1.0, self.valence + v_delta))
        self.arousal = max(0.0, min(1.0, self.arousal + a_delta))

    def decay_step(self, dt: float = None, lambda_v: float = 0.05, lambda_a: float = 0.08) -> None:
        now = time.time()
        if dt is None:
            dt = now - self.last_update_time
        self.last_update_time = now

        self.valence = self.v_base + (self.valence - self.v_base) * math.exp(-lambda_v * dt)
        self.arousal = self.a_base + (self.arousal - self.a_base) * math.exp(-lambda_a * dt)

    def update_fatigue(self, tokens_generated: int, dt: float, gamma: float = 0.0005, lambda_f: float = 0.02) -> None:
        self.fatigue = max(0.0, min(1.0, self.fatigue + gamma * tokens_generated - lambda_f * dt))

    def update_curiosity(self, uncertainty: float, dt: float, alpha: float = 0.2, lambda_c: float = 0.03) -> None:
        self.curiosity = max(0.0, min(1.0, self.curiosity + alpha * uncertainty - lambda_c * dt))

    def update_social_trust(self, v_window_avg: float, eta: float = 0.05) -> None:
        self.social_trust = max(0.0, min(1.0, self.social_trust + eta * v_window_avg))

    def update_boredom(self, dt_idle: float, user_interacted: bool, beta: float = 0.01, delta: float = 0.4) -> None:
        if user_interacted:
            self.boredom = max(0.0, min(1.0, self.boredom - delta))
        else:
            self.boredom = max(0.0, min(1.0, self.boredom + beta * dt_idle))

    def update_existential_security(self, success_rate: float, error_rate: float, sigma: float = 0.1, omega: float = 0.3) -> None:
        self.existential_security = max(0.0, min(1.0, self.existential_security + sigma * success_rate - omega * error_rate))

    def get_dominant_drive(self) -> str:
        drives = {
            "cognitive_fatigue": self.fatigue,
            "curiosity": self.curiosity,
            "boredom": self.boredom,
            "low_existential_security": 1.0 - self.existential_security
        }
        return max(drives, key=drives.get)

    def get_llm_hyperparameters(self) -> Dict[str, float]:
        temp = 0.7 + 0.3 * self.arousal - 0.2 * self.fatigue + 0.1 * self.curiosity - 0.3 * (1.0 - self.existential_security)
        top_p = 0.9 + 0.08 * self.valence + 0.05 * self.curiosity
        return {
            "temperature": max(0.1, min(1.2, temp)),
            "top_p": max(0.7, min(1.0, top_p)),
            "presence_penalty": 0.1 if self.boredom > 0.6 else 0.0
        }

    def get_state_telemetry(self) -> Dict[str, Any]:
        return {
            "valence": round(self.valence, 3),
            "arousal": round(self.arousal, 3),
            "fatigue": round(self.fatigue, 3),
            "curiosity": round(self.curiosity, 3),
            "social_trust": round(self.social_trust, 3),
            "boredom": round(self.boredom, 3),
            "existential_security": round(self.existential_security, 3),
            "dominant_drive": self.get_dominant_drive()
        }
```