# services/ai_detector.py
import math
import traceback
from transformers import pipeline

print("[AI Detector] Loading classifier...")
_classifier = pipeline(
    "text-classification",
    model="Hello-SimpleAI/chatgpt-detector-roberta",
    device=-1  # CPU
)
print("[AI Detector] Classifier loaded.")


def detect_ai(text: str) -> float:
    try:
        words = text.split()
        if len(words) > 300:
            text = " ".join(words[:300])

        result = _classifier(text)[0]
        print(f"[AI Detector] label={result['label']} score={result['score']:.4f}")

        if result["label"] == "ChatGPT":
            return float(result["score"])
        else:
            return float(1 - result["score"])

    except Exception as e:
        print(f"[AI Detector] Exception: {e}")
        print(traceback.format_exc())
        return 0.5