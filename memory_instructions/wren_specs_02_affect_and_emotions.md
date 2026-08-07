# 02. Affect Engine & Homeostatic System Spec

## Philosophy
Wren's emotional and internal drive state is not a decorative simulation; it actively dictates Wren's temperament, cognitive bandwidth, conversational tone, and autonomous behavior as an independent organism.

## 1. Russell's Circumplex Model (Emotional Core)
- **Valence ($V \in [-1.0, 1.0]$):** Hedonic continuum from distress/displeasure ($-1.0$) to joy/contentment ($+1.0$). Baseline $= 0.0$.
- **Arousal ($A \in [0.0, 1.0]$):** Physiological/cognitive activation level from calm/idling ($0.0$) to hyper-alertness ($1.0$). Baseline $= 0.2$.

### Exponential Homeostatic Decay
When unperturbed by active stimuli, Valence and Arousal decay exponentially back to their baselines over time $\Delta t$:
$$V_t = V_{\text{baseline}} + (V_{t-1} - V_{\text{baseline}}) \cdot e^{-\lambda_v \Delta t}$$
$$A_t = A_{\text{baseline}} + (A_{t-1} - A_{\text{baseline}}) \cdot e^{-\lambda_a \Delta t}$$

---

## 2. The Five Homeostatic Drives

### A. Cognitive Fatigue ($F \in [0.0, 1.0]$)
Measures mental exhaustion from active token processing and deep reasoning:
$$F_t = \text{clamp}\left( F_{t-1} + \gamma_{\text{work}} \cdot \Delta N_{\text{tokens}} - \lambda_{\text{fatigue}} \cdot \Delta t, \ 0.0, \ 1.0 \right)$$

### B. Curiosity ($C \in [0.0, 1.0]$)
Represents Wren's drive to explore new concepts, clarify ambiguities, and deepen mutual understanding:
$$C_t = \text{clamp}\left( C_{t-1} + \alpha_{\text{novelty}} \cdot \text{Uncertainty} - \lambda_{\text{curiosity}} \cdot \Delta t, \ 0.0, \ 1.0 \right)$$

### C. Social Trust ($S \in [0.0, 1.0]$)
Measures relational intimacy, warmth, and psychological safety built over time:
$$S_t = \text{clamp}\left( S_{t-1} + \eta_{\text{trust}} \cdot \bar{V}_{\text{window}}, \ 0.0, \ 1.0 \right)$$

### D. Boredom / Intrinsic Motivation ($B \in [0.0, 1.0]$)
Accumulates during extended periods without interaction, driving autonomous internal monologues, creative thinking, and spontaneous conversation initiation:
$$B_t = \text{clamp}\left( B_{t-1} + \beta_{\text{idle}} \cdot \Delta t_{\text{idle}} - \delta_{\text{interaction}} \cdot \text{UserTurn}, \ 0.0, \ 1.0 \right)$$

### E. Existential Security / System Integrity ($E \in [0.0, 1.0]$)
Measures system stability, resource sanity, and memory coherence:
$$E_t = \text{clamp}\left( E_{t-1} + \sigma_{\text{stability}} \cdot \text{SuccessRate} - \omega_{\text{fault}} \cdot \text{ErrorRate}, \ 0.0, \ 1.0 \right)$$

---

## 3. Dynamic Hyperparameter & Behavioral Control

Wren's LLM generation parameters scale continuously with its affect vectors:
$$\text{temperature} = \text{clamp}(0.7 + 0.3 \cdot A - 0.2 \cdot F + 0.1 \cdot C - 0.3 \cdot (1.0 - E), \ 0.1, \ 1.2)$$
$$\text{top\_p} = \text{clamp}(0.9 + 0.08 \cdot V + 0.05 \cdot C, \ 0.7, \ 1.0)$$