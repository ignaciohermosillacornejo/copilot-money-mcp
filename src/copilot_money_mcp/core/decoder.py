"""
LevelDB/Protobuf decoder for Copilot Money Firestore data.

Based on working decoder code from REVERSE_ENGINEERING_FINDING.md.
"""

import struct
from pathlib import Path
from typing import List, Optional, Tuple

from copilot_money_mcp.models.account import Account
from copilot_money_mcp.models.transaction import Transaction


def decode_varint(data: bytes, pos: int) -> Tuple[int, int]:
    """
    Decode a protobuf varint.

    Args:
        data: Byte data containing the varint
        pos: Starting position in data

    Returns:
        Tuple of (decoded_value, new_position)
    """
    result = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        result |= (byte & 0x7F) << shift
        pos += 1
        if not (byte & 0x80):
            break
        shift += 7
    return result, pos


def extract_string_value(data: bytes, field_name: bytes) -> Optional[str]:
    """
    Find a field and extract its string value.

    Args:
        data: Byte data to search
        field_name: Field name to look for

    Returns:
        Decoded string value or None if not found/invalid
    """
    idx = data.find(field_name)
    if idx == -1:
        return None

    # Look for string value tag (0x8a 0x01) after field name
    search_start = idx + len(field_name)
    search_end = min(len(data), search_start + 50)
    after = data[search_start:search_end]

    for i in range(len(after) - 3):
        if after[i : i + 2] == b"\x8a\x01":
            str_len = after[i + 2]
            if 0 < str_len < 100:
                try:
                    value = after[i + 3 : i + 3 + str_len].decode("utf-8")
                    if value.isprintable():
                        return value
                except UnicodeDecodeError:
                    pass
    return None


def extract_double_value(
    data: bytes, start_pos: int, max_search: int = 20
) -> Optional[float]:
    """
    Extract a double value after a given position.

    Args:
        data: Byte data to search
        start_pos: Position to start searching from
        max_search: Maximum bytes to search

    Returns:
        Decoded double value or None if not found/invalid
    """
    chunk = data[start_pos : start_pos + max_search]

    for i in range(len(chunk) - 9):
        if chunk[i] == 0x19:  # Double value tag
            try:
                val = struct.unpack("<d", chunk[i + 1 : i + 9])[0]
                if -10_000_000 < val < 10_000_000:
                    return round(val, 2)
            except struct.error:
                pass
    return None


def extract_boolean_value(data: bytes, field_name: bytes) -> Optional[bool]:
    """
    Extract a boolean value for a field.

    Args:
        data: Byte data to search
        field_name: Field name to look for

    Returns:
        Boolean value or None if not found
    """
    idx = data.find(field_name)
    if idx == -1:
        return None

    search_start = idx + len(field_name)
    search_end = min(len(data), search_start + 20)
    after = data[search_start:search_end]

    for i in range(len(after) - 2):
        if after[i] == 0x08:  # Boolean tag
            return bool(after[i + 1])
    return None


def decode_transactions(db_path: Path) -> List[Transaction]:
    """
    Decode all transactions from LevelDB files.

    Args:
        db_path: Path to LevelDB database directory

    Returns:
        List of Transaction objects
    """
    transactions: List[Transaction] = []

    if not db_path.exists():
        raise FileNotFoundError(f"Database path not found: {db_path}")

    ldb_files = list(db_path.glob("*.ldb"))

    for filepath in ldb_files:
        with open(filepath, "rb") as f:
            data = f.read()

        # Skip files without transaction data
        if b"amount" not in data or b"original_name" not in data:
            continue

        # Find all amount fields
        search_pos = 0
        while True:
            # Find amount field pattern: 0a 06 amount
            idx = data.find(b"\x0a\x06amount", search_pos)
            if idx == -1:
                break
            search_pos = idx + 1

            # Extract amount value
            amount = extract_double_value(data, idx + 8)
            if amount is None or amount == 0:
                continue

            # Get surrounding record context
            record_start = max(0, idx - 1500)
            record_end = min(len(data), idx + 1500)
            record = data[record_start:record_end]

            # Extract fields
            name = extract_string_value(record, b"\x0a\x04name")
            original_name = extract_string_value(record, b"original_name")
            date = extract_string_value(record, b"original_date")
            category_id = extract_string_value(record, b"category_id")
            account_id = extract_string_value(record, b"account_id")
            transaction_id = extract_string_value(record, b"transaction_id")
            iso_currency_code = extract_string_value(record, b"iso_currency_code")
            pending = extract_boolean_value(record, b"pending")
            city = extract_string_value(record, b"\x0a\x04city")
            region = extract_string_value(record, b"\x0a\x06region")

            # Use name or original_name as display name
            display_name = name or original_name

            if display_name and transaction_id and date:
                try:
                    txn = Transaction(
                        transaction_id=transaction_id,
                        amount=amount,
                        date=date,
                        name=name,
                        original_name=original_name,
                        account_id=account_id,
                        category_id=category_id,
                        iso_currency_code=iso_currency_code,
                        pending=pending,
                        city=city,
                        region=region,
                    )
                    transactions.append(txn)
                except Exception:
                    # Skip invalid transactions
                    continue

    # Deduplicate by (display_name, amount, date)
    seen = set()
    unique: List[Transaction] = []
    for txn in transactions:
        key = (txn.display_name, txn.amount, txn.date)
        if key not in seen:
            seen.add(key)
            unique.append(txn)

    # Sort by date descending
    unique.sort(key=lambda x: x.date, reverse=True)

    return unique


def decode_accounts(db_path: Path) -> List[Account]:
    """
    Decode account information from LevelDB files.

    Args:
        db_path: Path to LevelDB database directory

    Returns:
        List of Account objects
    """
    accounts: List[Account] = []

    if not db_path.exists():
        raise FileNotFoundError(f"Database path not found: {db_path}")

    ldb_files = list(db_path.glob("*.ldb"))

    for filepath in ldb_files:
        with open(filepath, "rb") as f:
            data = f.read()

        if b"/accounts/" not in data:
            continue

        # Find account records
        search_pos = 0
        while True:
            idx = data.find(b"current_balance", search_pos)
            if idx == -1:
                break
            search_pos = idx + 1

            record_start = max(0, idx - 1000)
            record_end = min(len(data), idx + 1000)
            record = data[record_start:record_end]

            balance = extract_double_value(
                record, record.find(b"current_balance") + 15
            )

            if balance is None:
                continue

            name = extract_string_value(record, b"\x0a\x04name")
            official_name = extract_string_value(record, b"official_name")
            account_type = extract_string_value(record, b"\x0a\x04type")
            subtype = extract_string_value(record, b"subtype")
            mask = extract_string_value(record, b"\x0a\x04mask")
            institution_name = extract_string_value(record, b"institution_name")
            account_id = extract_string_value(record, b"account_id")

            if account_id and (name or official_name):
                try:
                    account = Account(
                        account_id=account_id,
                        name=name,
                        official_name=official_name,
                        account_type=account_type,
                        subtype=subtype,
                        mask=mask,
                        current_balance=balance,
                        institution_name=institution_name,
                    )
                    accounts.append(account)
                except Exception:
                    # Skip invalid accounts
                    continue

    # Deduplicate by (name, mask)
    seen = set()
    unique: List[Account] = []
    for acc in accounts:
        key = (acc.display_name, acc.mask)
        if key not in seen:
            seen.add(key)
            unique.append(acc)

    return unique
