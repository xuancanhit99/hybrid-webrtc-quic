"""PyInstaller entry point for the Hybrid Windows host agent."""

import sys

from hybrid_agent.agent import main


if __name__ == "__main__":
    raise SystemExit(main())
