import unittest
from pathlib import Path

from migrate import migration_names


class MigrationRunnerTest(unittest.TestCase):
    def test_selects_sql_migrations_in_lexical_order(self):
        names = migration_names([
            Path("0002_performance.sql"),
            Path("notes.md"),
            Path("0001_core.sql"),
        ])
        self.assertEqual(names, ["0001_core.sql", "0002_performance.sql"])


if __name__ == "__main__":
    unittest.main()
