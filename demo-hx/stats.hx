# [xihanzu-NR]
# List/dict/comprehension idioms a Python dev reaches for without thinking.

from serpent_js import sorted_by, sum, len, truthy

SCORES = [
    {"name": "ada", "score": 92},
    {"name": "bob", "score": 78},
    {"name": "cyd", "score": 95},
]

def average(rows: list) -> float:
    if not truthy(rows):
        return 0.0
    return sum([r["score"] for r in rows]) / len(rows)

def top(rows: list, count: int) -> list:
    ranked = sorted_by(rows, lambda r: r["score"])
    return reversed(ranked)[0:count]

def passing(rows: list, threshold: int = 80) -> list:
    return [r["name"] for r in rows if r["score"] >= threshold]

print(f"average: {average(SCORES)}")
print(f"top 2:   {top(SCORES, 2)}")
print(f"passing: {passing(SCORES)}")
print(f"passing at 90: {passing(SCORES, 90)}")
