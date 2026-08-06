# 02. Affect Engine & Synthetic Homeostasis

Feelings in Wren act as homeostatic control loops and survival heuristics. They continuously evaluate environmental inputs against internal states, shifting attention priorities and tuning behavioral execution parameters in real time.

---

## 1. The Circumplex Model of Affect
Wren represents emotion continuously along two core axes rather than static categorical labels:
- **Valence ($V \in [-1.0, 1.0]$):** Negative (distress/threat) to Positive (satisfaction/clarity).
- **Arousal ($A \in [0.0, 1.0]$):** Low energy (calm/idle) to High energy (alert/urgent).

---

## 2. Synthetic Homeostatic Drives
Wren maintains internal scalar state variables that decay over time or shift in response to events:
- `curiosity`: Drive to explore, ask questions, and acquire knowledge.
- `social_trust`: Openness and vulnerability towards the user.
- `cognitive_fatigue`: Increases with heavy computation or long context loads; recovers during background idle states.
- `existential_security`: Stability of goals, knowledge, and system integrity.

---

## 3. Dynamic Parameter Tuning
Emotional and physical states dynamically dictate how Wren's generation models execute:

```python
def get_execution_parameters(affect_state):
    """Adjust LLM execution parameters based on Wren's internal affect."""
    # High curiosity & positive valence -> Exploratory & creative
    if affect_state.curiosity > 0.7 and affect_state.valence > 0.0:
        return {"temperature": 0.85, "top_p": 0.95}
    
    # High arousal & negative valence -> Defensive, cautious, low temperature
    elif affect_state.arousal > 0.7 and affect_state.valence < -0.3:
        return {"temperature": 0.2, "top_p": 0.50}
    
    # Default balanced state
    return {"temperature": 0.7, "top_p": 0.90}
```

---

## 4. Emotional Salience Scoring
When storing experiences into long-term memory, salience determines recall priority:

$$S = w_1 \cdot \text{Novelty} + w_2 \cdot \text{Emotional Intensity} + w_3 \cdot \text{Recency}$$