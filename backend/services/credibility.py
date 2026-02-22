from urllib.parse import urlparse
import numpy as np
from .domain_trust import DOMAIN_TRUST

TYPE_WEIGHTS = {
    "news": 1.0,
    "research": 0.95,
    "pdf": 0.85,
    "blog": 0.65,
    "unknown": 0.60,
}

RESEARCH_DOMAINS = {
    "arxiv.org", "pubmed.ncbi.nlm.nih.gov", "nature.com", "science.org",
    "nejm.org", "thelancet.com", "jamanetwork.com", "bmj.com", "plos.org",
}
NEWS_DOMAINS = {
    "nytimes.com", "theguardian.com", "bbc.com", "reuters.com", "apnews.com",
    "washingtonpost.com", "bloomberg.com", "npr.org", "axios.com", "cnbc.com",
}


def get_domain_trust(url: str) -> float:
    try:
        domain = urlparse(url).netloc.replace("www.", "")
        if domain in DOMAIN_TRUST:
            return DOMAIN_TRUST[domain]
        for known_domain, trust in DOMAIN_TRUST.items():
            if domain.endswith(known_domain):
                return trust
        return 0.40
    except Exception:
        return 0.40


def get_content_type(url: str, hint: str = "blog") -> str:
    try:
        domain = urlparse(url).netloc.replace("www.", "")
        if domain in RESEARCH_DOMAINS:
            return "research"
        if domain in NEWS_DOMAINS:
            return "news"
        if ".gov" in domain or ".edu" in domain:
            return "research"
    except Exception:
        pass
    return hint


def burstiness(text: str) -> float:
    sentences = [s.strip() for s in text.split('.') if len(s.strip().split()) > 2]
    if len(sentences) < 3:
        return 0.5
    lengths = [len(s.split()) for s in sentences]
    mean = np.mean(lengths)
    std = np.std(lengths)
    if mean == 0:
        return 0.5
    cv = std / mean
    return float(min(cv / 0.8, 1.0))


def score_credibility(ai_prob: float, url: str, content_type: str = "blog", text: str = None):
    domain_trust = get_domain_trust(url)
    domain = urlparse(url).netloc.replace("www.", "")

    content_type = get_content_type(url, content_type)
    type_weight = TYPE_WEIGHTS.get(content_type, 0.60)

    # Force high ai_prob for known low-trust/AI farm domains
    if domain_trust <= 0.25:
        ai_prob = max(ai_prob, 0.90)

    length = min(len(text.split()) / 500, 1.0) if text else 0.5
    burst = burstiness(text) if text else 0.5

    # Weighted average — domain trust is the dominant signal
    score = (
        (1 - ai_prob) * 35 +   # max 35pts
        domain_trust  * 40 +   # max 40pts
        type_weight   * 15 +   # max 15pts
        length        * 5  +   # max 5pts
        burst         * 5      # max 5pts
    )

    # Hard cap at 92 — nothing is perfect
    total = round(min(score, 92), 2)

    # Build reasoning
    reasons = []

    if ai_prob > 0.65:
        reasons.append(f"Content appears likely AI-generated ({round(ai_prob * 100)}% probability)")
    elif ai_prob < 0.35:
        reasons.append(f"Content appears human-written ({round((1 - ai_prob) * 100)}% confidence)")
    else:
        reasons.append(f"AI authorship is uncertain ({round(ai_prob * 100)}% AI probability)")

    if domain_trust >= 0.90:
        reasons.append(f"{domain} is a highly trusted source")
    elif domain_trust >= 0.75:
        reasons.append(f"{domain} has moderate-to-high domain trust")
    elif domain_trust >= 0.50:
        reasons.append(f"{domain} has below-average domain trust")
    elif domain_trust <= 0.25:
        reasons.append(f"{domain} is a low-trust or AI content source")
    else:
        reasons.append(f"{domain} is an unknown domain with no established trust score")

    if content_type == "news":
        reasons.append("Recognized as a news source")
    elif content_type == "research":
        reasons.append("Academic or research content carries high credibility weight")
    elif content_type == "blog":
        reasons.append("Blog content carries lower credibility weight")

    if text:
        word_count = len(text.split())
        if word_count >= 500:
            reasons.append(f"Substantive article length ({word_count} words)")
        elif word_count < 150:
            reasons.append(f"Short content may lack depth ({word_count} words)")
        if burst > 0.65:
            reasons.append("High sentence variation suggests human authorship")
        elif burst < 0.35:
            reasons.append("Low sentence variation is consistent with AI writing")

    return {
        "credibility_score": total,
        "reasoning": reasons,
        "signals": {
            "ai_detection": round(1 - ai_prob, 3),
            "domain_trust": round(domain_trust, 3),
            "content_type": round(type_weight, 3),
            "length": round(length, 3),
            "burstiness": round(burst, 3),
        },
    }