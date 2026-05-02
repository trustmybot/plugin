#!/usr/bin/env python3
"""Simple CLI todo app — local JSON storage."""
import argparse
import json
import os

TODO_FILE = os.environ.get("TODO_FILE", os.path.expanduser("~/.todo/todos.json"))


def load():
    os.makedirs(os.path.dirname(TODO_FILE), exist_ok=True)
    if not os.path.exists(TODO_FILE):
        return []
    with open(TODO_FILE) as f:
        return json.load(f)


def save(todos):
    os.makedirs(os.path.dirname(TODO_FILE), exist_ok=True)
    with open(TODO_FILE + ".tmp", "w") as f:
        json.dump(todos, f, indent=2)
    os.replace(TODO_FILE + ".tmp", TODO_FILE)


def cmd_add(title):
    todos = load()
    todos.append({"id": len(todos) + 1, "title": title, "done": False})
    save(todos)
    print(f"Added: {title}")


def cmd_list():
    todos = load()
    for t in todos:
        status = "✓" if t["done"] else "○"
        print(f"  {status} {t['id']}. {t['title']}")


def cmd_done(id_):
    todos = load()
    for t in todos:
        if t["id"] == id_:
            t["done"] = True
            save(todos)
            print(f"Done: {t['title']}")
            return
    print(f"No todo with id {id_}")


def cmd_rm(id_):
    todos = load()
    todos = [t for t in todos if t["id"] != id_]
    save(todos)
    print(f"Removed id {id_}")


def main():
    parser = argparse.ArgumentParser(description="CLI todo")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("title")
    sub.add_parser("list")
    done = sub.add_parser("done")
    done.add_argument("id", type=int)
    rm = sub.add_parser("rm")
    rm.add_argument("id", type=int)

    args = parser.parse_args()
    if args.cmd == "add":
        cmd_add(args.title)
    elif args.cmd == "list":
        cmd_list()
    elif args.cmd == "done":
        cmd_done(args.id)
    elif args.cmd == "rm":
        cmd_rm(args.id)


if __name__ == "__main__":
    main()
