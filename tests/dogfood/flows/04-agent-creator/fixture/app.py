#!/usr/bin/env python3
"""Minimal SQLite-backed task tracker. Subject of architect's read."""
import sqlite3
import threading
from pathlib import Path

DB = Path('tasks.db')
_lock = threading.Lock()


def init():
    with sqlite3.connect(DB) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT)')


def add_task(title: str) -> int:
    with _lock, sqlite3.connect(DB) as conn:
        cur = conn.execute('INSERT INTO tasks (title, status) VALUES (?, ?)', (title, 'open'))
        return cur.lastrowid


def list_tasks(status: str = None):
    with sqlite3.connect(DB) as conn:
        if status:
            return conn.execute('SELECT * FROM tasks WHERE status=?', (status,)).fetchall()
        return conn.execute('SELECT * FROM tasks').fetchall()


def close_task(task_id: int):
    with _lock, sqlite3.connect(DB) as conn:
        conn.execute('UPDATE tasks SET status=? WHERE id=?', ('closed', task_id))


if __name__ == '__main__':
    init()
    print("tasks db ready")
