#!/usr/bin/env python3
"""
Copy Copilot Money demo database for testing.

This script copies the Firestore LevelDB database from Copilot Money's
local storage to the test fixtures directory.

IMPORTANT: Do NOT commit the demo database to version control as it
contains real financial data.
"""

import shutil
from pathlib import Path

# Source: Copilot Money's Firestore local cache
SOURCE_PATH = Path.home() / (
    "Library/Containers/com.copilot.production/Data/Library/Application Support/"
    "firestore/__FIRAPP_DEFAULT/copilot-production-22904/main"
)

# Destination: Test fixtures
DEST_PATH = Path(__file__).parent.parent / "tests/fixtures/demo_database"


def copy_demo_database():
    """Copy the demo database to test fixtures."""
    if not SOURCE_PATH.exists():
        print(f"Error: Source database not found at {SOURCE_PATH}")
        print("Please ensure Copilot Money is installed and has synced data.")
        return False

    # Create destination directory
    DEST_PATH.mkdir(parents=True, exist_ok=True)

    # Copy all .ldb files and manifest
    files_copied = 0
    for file_path in SOURCE_PATH.glob("*"):
        if file_path.suffix in [".ldb", ".log"] or file_path.name.startswith("MANIFEST"):
            dest_file = DEST_PATH / file_path.name
            shutil.copy2(file_path, dest_file)
            files_copied += 1
            print(f"Copied: {file_path.name}")

    # Also copy CURRENT and LOCK if they exist
    for special_file in ["CURRENT", "LOCK"]:
        source_file = SOURCE_PATH / special_file
        if source_file.exists():
            shutil.copy2(source_file, DEST_PATH / special_file)
            files_copied += 1
            print(f"Copied: {special_file}")

    print(f"\nSuccessfully copied {files_copied} files to {DEST_PATH}")
    print("\nWARNING: Demo database is .gitignored - do NOT commit to version control!")
    return True


if __name__ == "__main__":
    import sys
    success = copy_demo_database()
    sys.exit(0 if success else 1)
