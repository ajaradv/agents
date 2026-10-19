"""Shared bits for the repo's Python scripts agents run, so they follow the AXI
principles (docs/tool-standards.md): errors on stdout with a suggestion and
exit 2 for bad usage, --help with examples, TOON tables with counts, and a
content-first home view when run with no arguments.

Import it as `import axi_cli` from a script in bin/ (the script's folder is on
sys.path). Its bytecode in bin/__pycache__ is gitignored.
"""
from __future__ import annotations

import argparse
import sys


def cell(v: object) -> str:
    """One TOON value: quoted when it holds a comma, colon, quote, or leading/trailing space."""
    s = "null" if v is None or v == "" else str(v).replace("\n", " ")
    if any(c in s for c in ',:"') or s != s.strip() or s.startswith("-"):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def table(name: str, fields: list[str], rows: list[dict]) -> str:
    """A TOON table with its count: name[N]{a,b}: then one row per line; '0' when empty."""
    if not rows:
        return f"{name}: 0"
    head = f"{name}[{len(rows)}]{{{','.join(fields)}}}:"
    return "\n".join([head] + ["  " + ",".join(cell(r.get(f)) for f in fields) for r in rows])


def hints(lines: list[str]) -> str:
    return f"help[{len(lines)}]:\n" + "\n".join(f"  {h}" for h in lines) if lines else ""


def fail(message: str, suggestion: str, code: int = 1) -> int:
    """An error the agent can act on, on stdout (agents read stdout, not stderr)."""
    print(f"error: {cell(message)}")
    print(f"suggestion: {suggestion}")
    return code


class Parser(argparse.ArgumentParser):
    """argparse with AXI errors (stdout, a suggestion, exit 2) and examples in --help."""

    def __init__(self, *args, examples: list[str] | None = None, **kw):
        kw.setdefault("formatter_class", argparse.RawDescriptionHelpFormatter)
        if examples:
            kw["epilog"] = (kw.get("epilog") or "") + "examples:\n" + "\n".join(f"  {e}" for e in examples)
        super().__init__(*args, **kw)

    def error(self, message: str):  # noqa: D401 - argparse API
        print(f"error: {cell(message)}")
        print(f"suggestion: {self.prog} --help")
        sys.exit(2)
