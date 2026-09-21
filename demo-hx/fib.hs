# [xihanzu-NR]
# Classic recursion — the thing `def` should make painless.

def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

def fib_list(count: int) -> list:
    return [fib(i) for i in range(count)]

print(f"first 10 fibonacci: {fib_list(10)}")
