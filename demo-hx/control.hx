# [xihanzu-NR]
# Control flow that has no place in a component tree.

def countdown(n: int):
    while n > 0:
        if n % 2 == 0:
            print(f"{n} (even)")
        n -= 1
    print("liftoff")

def first_match(xs: list, target: int):
    for i, x in enumerate(xs):
        if x != target:
            continue
        return i
    return -1

def parse_int(text: str):
    try:
        return int(text)
    except ValueError:
        print(f"not a number: {text}")
        return None
    finally:
        print(f"parse_int({text}) done")

countdown(5)
print(f"index of 3: {first_match([1, 2, 3, 4], 3)}")
print(f"index of 9: {first_match([1, 2, 3, 4], 9)}")
print(f"parse '42': {parse_int('42')}")
print(f"parse 'xx': {parse_int('xx')}")
