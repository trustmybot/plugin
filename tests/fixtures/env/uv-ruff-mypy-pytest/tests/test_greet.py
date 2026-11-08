from sample import greet


def test_greet() -> None:
    assert greet("a") == "hello a"
