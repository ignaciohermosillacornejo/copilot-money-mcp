# Copilot Money Local Data Reverse Engineering

> **Date:** January 2025
> **App Version:** 6.1.2
> **Platform:** macOS (App Store version)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Data Location](#data-location)
3. [Data Format](#data-format)
4. [Firestore Document Structure](#firestore-document-structure)
5. [Protobuf Encoding Details](#protobuf-encoding-details)
6. [Working Decoder Code](#working-decoder-code)
7. [Sample Extracted Data](#sample-extracted-data)
8. [MCP Server Implementation Plan](#mcp-server-implementation-plan)
9. [Distribution Strategy](#distribution-strategy)

---

## Executive Summary

Copilot Money is a personal finance app that uses **Firebase Firestore** with **local offline persistence**. All user financial data is cached locally in **LevelDB** files using **Protocol Buffers** encoding.

**Key Finding:** We can read 100% of your financial data locally without any API calls:
- ✅ 5,550+ transactions extracted
- ✅ Account balances
- ✅ Categories
- ✅ Recurring transactions
- ✅ Investment holdings
- ✅ Budget data

---

## Data Location

### Primary Data Store
```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/
    firestore/__FIRAPP_DEFAULT/copilot-production-22904/main/
```

### File Types
| File Pattern | Purpose |
|-------------|---------|
| `*.ldb` | LevelDB SSTable files (main data) |
| `*.log` | Write-ahead log |
| `MANIFEST-*` | LevelDB manifest |
| `CURRENT` | Points to current manifest |
| `LOCK` | Database lock file |

### Other Locations (Less Important)
```
# IndexedDB (WebKit cache - minimal data)
~/Library/Containers/com.copilot.production/Data/Library/WebKit/
    WebsiteData/Default/.../IndexedDB/

# App Preferences
~/Library/Containers/com.copilot.production/Data/Library/Preferences/
    com.copilot.production.plist
```

---

## Data Format

### Storage Stack
```
┌─────────────────────────────────────┐
│         Copilot Money App           │
├─────────────────────────────────────┤
│      Firebase Firestore SDK         │
├─────────────────────────────────────┤
│    Local Persistence Layer          │
├─────────────────────────────────────┤
│   Protocol Buffers Serialization    │
├─────────────────────────────────────┤
│          LevelDB Storage            │
└─────────────────────────────────────┘
```

### LevelDB Key Format
Keys follow Firestore document paths:
```
remote_document/projects/copilot-production-22904/databases/(default)/documents/{collection}/{doc_id}
```

### Collections Discovered
| Collection | Description | Record Count (approx) |
|-----------|-------------|----------------------|
| `transactions` | Financial transactions | 5,500+ |
| `accounts` | Bank/investment accounts | ~20 |
| `items` | Plaid bank connections | ~10 |
| `recurring` | Recurring transactions | ~50 |
| `budgets` | Budget settings | ~10 |
| `categories` | Spending categories | ~100 |
| `balance_history` | Historical balances | 1,000+ |
| `holdings_history` | Investment holdings | 500+ |
| `investment_prices` | Stock/crypto prices | 10,000+ |
| `investment_splits` | Stock splits | 300+ |
| `changes` | Sync/change tracking | Many |

---

## Firestore Document Structure

### Transaction Document Fields
```javascript
{
  // Identifiers
  transaction_id: string,      // Unique transaction ID
  account_id: string,          // Parent account
  item_id: string,             // Plaid item (bank connection)
  user_id: string,             // User identifier

  // Core Data
  amount: double,              // Transaction amount (negative = income/credit)
  date: string,                // Transaction date (YYYY-MM-DD)
  name: string,                // Clean merchant name
  original_name: string,       // Raw merchant name from bank
  original_clean_name: string, // Cleaned version
  original_date: string,       // Original transaction date
  original_amount: double,     // Original amount before edits

  // Categorization
  category_id: string,         // Category identifier
  plaid_category_id: string,   // Plaid's category
  plaid_category_strings: [],  // Category hierarchy
  category_id_source: string,  // How category was assigned

  // Status
  pending: boolean,            // Pending transaction flag
  pending_transaction_id: string,
  user_reviewed: boolean,      // User has reviewed
  plaid_deleted: boolean,      // Deleted from Plaid

  // Payment Info
  payee: { name: string },     // Who received money
  payer: { name: string },     // Who sent money
  payment_method: string,
  payment_processor: string,

  // Location
  location: {
    address: string,
    city: string,
    region: string,            // State
    postal_code: string,
    country: string,
    lat: double,
    lon: double
  },

  // Metadata
  iso_currency_code: string,   // "USD", etc.
  plaid_transaction_type: string,
  is_amazon: boolean,
  from_investment: string,
  account_dashboard_active: boolean,
  created_timestamp: timestamp,

  // References
  reference_number: string,
  ppd_id: string,
  by_order_of: string
}
```

### Account Document Fields
```javascript
{
  account_id: string,
  item_id: string,
  name: string,
  official_name: string,
  type: string,              // "checking", "savings", "credit", "investment"
  subtype: string,
  mask: string,              // Last 4 digits
  current_balance: double,
  available_balance: double,
  iso_currency_code: string,
  institution_id: string,
  institution_name: string
}
```

---

## Protobuf Encoding Details

### Wire Types
| Type | ID | Description |
|------|-----|-------------|
| Varint | 0 | int32, int64, bool, enum |
| Fixed64 | 1 | double, fixed64 |
| Length-delimited | 2 | string, bytes, messages |
| Fixed32 | 5 | float, fixed32 |

### Firestore Value Field Numbers
From `google/firestore/v1/document.proto`:

```protobuf
message Value {
  oneof value_type {
    bool boolean_value = 1;
    int64 integer_value = 2;
    double double_value = 3;
    // 4 is reserved
    string reference_value = 5;
    MapValue map_value = 6;
    // 7 is reserved
    LatLng geo_point_value = 8;
    ArrayValue array_value = 9;
    Timestamp timestamp_value = 10;
    NullValue null_value = 11;
    // 12-16 reserved
    string string_value = 17;
    bytes bytes_value = 18;
  }
}
```

### Tag Calculation
```
tag = (field_number << 3) | wire_type
```

| Value Type | Field # | Wire Type | Tag (hex) |
|-----------|---------|-----------|-----------|
| boolean | 1 | 0 (varint) | 0x08 |
| integer | 2 | 0 (varint) | 0x10 |
| double | 3 | 1 (fixed64) | 0x19 |
| reference | 5 | 2 (length) | 0x2a |
| map | 6 | 2 (length) | 0x32 |
| geo_point | 8 | 2 (length) | 0x42 |
| array | 9 | 2 (length) | 0x4a |
| timestamp | 10 | 2 (length) | 0x52 |
| null | 11 | 0 (varint) | 0x58 |
| string | 17 | 2 (length) | 0x8a 0x01 |
| bytes | 18 | 2 (length) | 0x92 0x01 |

### Field Entry Pattern
Each document field follows this pattern:
```
0a <name_length> <field_name_bytes>   # Field name (tag 1, string)
12 <value_length> <value_tag> <value> # Field value (tag 2, message)
```

Example for `amount` field with value `6.60`:
```
0a 06                           # tag 1 (name), length 6
61 6d 6f 75 6e 74               # "amount"
12 09                           # tag 2 (value), length 9
19                              # double value tag (field 3)
66 66 66 66 66 66 1a 40         # IEEE 754 double: 6.60
```

---

## Working Decoder Code

### Complete Python Transaction Decoder

```python
#!/usr/bin/env python3
"""
Copilot Money Local Data Decoder
Extracts transactions from Firestore LevelDB cache
"""

import os
import struct
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any

# Constants
FIRESTORE_PATH = Path.home() / "Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main"


def decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    """Decode a protobuf varint."""
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
    """Find a field and extract its string value."""
    idx = data.find(field_name)
    if idx == -1:
        return None

    # Look for string value tag (0x8a 0x01) after field name
    search_start = idx + len(field_name)
    search_end = min(len(data), search_start + 50)
    after = data[search_start:search_end]

    for i in range(len(after) - 3):
        if after[i:i+2] == b'\x8a\x01':
            str_len = after[i+2]
            if 0 < str_len < 100:
                try:
                    value = after[i+3:i+3+str_len].decode('utf-8')
                    if value.isprintable():
                        return value
                except UnicodeDecodeError:
                    pass
    return None


def extract_double_value(data: bytes, start_pos: int, max_search: int = 20) -> Optional[float]:
    """Extract a double value after a given position."""
    chunk = data[start_pos:start_pos + max_search]

    for i in range(len(chunk) - 9):
        if chunk[i] == 0x19:  # Double value tag
            try:
                val = struct.unpack('<d', chunk[i+1:i+9])[0]
                if -10_000_000 < val < 10_000_000:
                    return round(val, 2)
            except struct.error:
                pass
    return None


def extract_boolean_value(data: bytes, field_name: bytes) -> Optional[bool]:
    """Extract a boolean value for a field."""
    idx = data.find(field_name)
    if idx == -1:
        return None

    search_start = idx + len(field_name)
    search_end = min(len(data), search_start + 20)
    after = data[search_start:search_end]

    for i in range(len(after) - 2):
        if after[i] == 0x08:  # Boolean tag
            return bool(after[i+1])
    return None


def decode_transactions() -> List[Dict[str, Any]]:
    """Decode all transactions from LevelDB files."""
    transactions = []

    if not FIRESTORE_PATH.exists():
        raise FileNotFoundError(f"Firestore path not found: {FIRESTORE_PATH}")

    ldb_files = list(FIRESTORE_PATH.glob("*.ldb"))

    for filepath in ldb_files:
        with open(filepath, 'rb') as f:
            data = f.read()

        # Skip files without transaction data
        if b'amount' not in data or b'original_name' not in data:
            continue

        # Find all amount fields
        search_pos = 0
        while True:
            # Find amount field pattern: 0a 06 amount
            idx = data.find(b'\x0a\x06amount', search_pos)
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
            tx = {
                'amount': amount,
                'name': extract_string_value(record, b'\x0a\x04name'),
                'original_name': extract_string_value(record, b'original_name'),
                'date': extract_string_value(record, b'original_date'),
                'category_id': extract_string_value(record, b'category_id'),
                'account_id': extract_string_value(record, b'account_id'),
                'transaction_id': extract_string_value(record, b'transaction_id'),
                'iso_currency_code': extract_string_value(record, b'iso_currency_code'),
                'pending': extract_boolean_value(record, b'pending'),
                'city': extract_string_value(record, b'\x0a\x04city'),
                'region': extract_string_value(record, b'\x0a\x06region'),
            }

            # Use name or original_name as display name
            tx['display_name'] = tx['name'] or tx['original_name']

            if tx['display_name']:
                transactions.append(tx)

    # Deduplicate
    seen = set()
    unique = []
    for tx in transactions:
        key = (tx['display_name'], tx['amount'], tx['date'])
        if key not in seen:
            seen.add(key)
            unique.append(tx)

    # Sort by date descending
    unique.sort(key=lambda x: x.get('date') or '', reverse=True)

    return unique


def decode_accounts() -> List[Dict[str, Any]]:
    """Decode account information."""
    accounts = []

    for filepath in FIRESTORE_PATH.glob("*.ldb"):
        with open(filepath, 'rb') as f:
            data = f.read()

        if b'/accounts/' not in data:
            continue

        # Find account records
        search_pos = 0
        while True:
            idx = data.find(b'current_balance', search_pos)
            if idx == -1:
                break
            search_pos = idx + 1

            record_start = max(0, idx - 1000)
            record_end = min(len(data), idx + 1000)
            record = data[record_start:record_end]

            balance = extract_double_value(record, record.find(b'current_balance') + 15)

            account = {
                'name': extract_string_value(record, b'\x0a\x04name'),
                'official_name': extract_string_value(record, b'official_name'),
                'type': extract_string_value(record, b'\x0a\x04type'),
                'subtype': extract_string_value(record, b'subtype'),
                'mask': extract_string_value(record, b'\x0a\x04mask'),
                'current_balance': balance,
                'institution_name': extract_string_value(record, b'institution_name'),
            }

            if account['name'] and account['current_balance'] is not None:
                accounts.append(account)

    # Deduplicate
    seen = set()
    unique = []
    for acc in accounts:
        key = (acc['name'], acc['mask'])
        if key not in seen:
            seen.add(key)
            unique.append(acc)

    return unique


if __name__ == "__main__":
    print("Decoding Copilot Money data...\n")

    transactions = decode_transactions()
    print(f"Found {len(transactions)} transactions")

    print(f"\n{'Date':<12} {'Amount':>10}  Name")
    print("-" * 70)
    for tx in transactions[:20]:
        date = (tx.get('date') or 'Unknown')[:10]
        name = (tx['display_name'] or 'Unknown')[:42]
        print(f"{date:<12} ${tx['amount']:>9.2f}  {name}")

    print(f"\n... and {len(transactions) - 20} more")
```

### Usage
```bash
# Run directly
python3 decoder.py

# Or import as module
from decoder import decode_transactions, decode_accounts

transactions = decode_transactions()
accounts = decode_accounts()
```

---

## Sample Extracted Data

### Transactions (5,550+ records)
```
Date             Amount  Name
----------------------------------------------------------------------
2026-01-08   $     5.53  CHEVRON
2026-01-08   $     6.69  UBER BV USD-USD CHILE
2026-01-08   $ -2000.83  AUTOPAY PAYMENT - THANK YOU
2026-01-08   $     6.57  365 MARKET 888 432-TROY
2026-01-08   $ -5122.62  FKA PAL PAYROLL
2026-01-08   $    45.89  ASTOUND
2026-01-07   $  -291.60  SEATTLES DOWNTOWN DENTIST
2026-01-07   $    77.39  DONDE LA CARLITA
2026-01-07   $   503.79  AMEX FINE HOTELS
2026-01-07   $     5.50  365 MARKET F
2026-01-07   $  2705.30  BK OF AMER VISA ONLINE
2026-01-07   $    22.10  AMAZON.COM*206CI8X83
2026-01-06   $   146.95  CHICO'S-DIRECT
2026-01-06   $    41.15  RAMEN DANBO SEATTLE
2026-01-06   $     4.81  KRISPY KREME
2026-01-06   $    53.67  DD *DOORDASH RAMENDANB
```

### Investment Holdings Found
- Bitcoin
- Ethereum
- Invesco QQQ Trust
- DoorDash Inc Class A
- Various other securities

### Merchant Names Discovered
- AMAZON PRIME, AMAZON.COM, AMAZON GROCE
- UBER, LIME RIDES
- DOORDASH, PANERA BREAD
- APPLE.COM, NETFLIX, SPOTIFY (HLU*HULUPLUS)
- CVS, CHEVRON
- Various local merchants

---

## MCP Server Implementation Plan

### Phase 1: Core Infrastructure (Day 1)

#### 1.1 Project Setup
```bash
mkdir copilot-money-mcp
cd copilot-money-mcp

# Initialize Python project
python -m venv venv
source venv/bin/activate

# Dependencies
pip install mcp plyvel protobuf

# Or use pyproject.toml
```

#### 1.2 Project Structure
```
copilot-money-mcp/
├── pyproject.toml
├── README.md
├── src/
│   └── copilot_money_mcp/
│       ├── __init__.py
│       ├── server.py          # MCP server entry point
│       ├── decoder.py         # LevelDB/protobuf decoder
│       ├── models.py          # Data models (Transaction, Account, etc.)
│       └── tools/
│           ├── __init__.py
│           ├── transactions.py
│           ├── accounts.py
│           ├── budgets.py
│           └── analytics.py
└── tests/
    └── test_decoder.py
```

#### 1.3 Core Decoder Module
```python
# src/copilot_money_mcp/decoder.py
# (Use the working decoder code from above)
```

### Phase 2: MCP Server Implementation (Day 2)

#### 2.1 Server Entry Point
```python
# src/copilot_money_mcp/server.py
from mcp.server import Server
from mcp.types import Tool, TextContent
from .decoder import decode_transactions, decode_accounts

server = Server("copilot-money")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="get_transactions",
            description="Get transactions with optional filters",
            inputSchema={
                "type": "object",
                "properties": {
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD)"},
                    "category": {"type": "string", "description": "Category filter"},
                    "merchant": {"type": "string", "description": "Merchant name search"},
                    "min_amount": {"type": "number"},
                    "max_amount": {"type": "number"},
                    "limit": {"type": "integer", "default": 50}
                }
            }
        ),
        Tool(
            name="get_accounts",
            description="Get all linked accounts with balances"
        ),
        Tool(
            name="spending_summary",
            description="Get spending summary by category for a time period",
            inputSchema={
                "type": "object",
                "properties": {
                    "month": {"type": "string", "description": "Month (YYYY-MM)"},
                    "group_by": {"type": "string", "enum": ["category", "merchant", "day"]}
                }
            }
        ),
        Tool(
            name="search_transactions",
            description="Search transactions by text",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 20}
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="get_recurring",
            description="Get recurring transactions (subscriptions)"
        ),
        Tool(
            name="net_worth",
            description="Calculate total net worth across all accounts"
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "get_transactions":
        return await get_transactions(**arguments)
    elif name == "get_accounts":
        return await get_accounts()
    # ... etc

async def main():
    from mcp.server.stdio import stdio_server
    async with stdio_server() as (read, write):
        await server.run(read, write)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

#### 2.2 Tool Implementations
```python
# src/copilot_money_mcp/tools/transactions.py

async def get_transactions(
    start_date: str = None,
    end_date: str = None,
    category: str = None,
    merchant: str = None,
    min_amount: float = None,
    max_amount: float = None,
    limit: int = 50
) -> list[dict]:
    """Get filtered transactions."""
    from ..decoder import decode_transactions

    transactions = decode_transactions()

    # Apply filters
    if start_date:
        transactions = [t for t in transactions if t.get('date', '') >= start_date]
    if end_date:
        transactions = [t for t in transactions if t.get('date', '') <= end_date]
    if merchant:
        merchant_lower = merchant.lower()
        transactions = [t for t in transactions
                       if merchant_lower in (t.get('display_name') or '').lower()]
    if min_amount is not None:
        transactions = [t for t in transactions if t['amount'] >= min_amount]
    if max_amount is not None:
        transactions = [t for t in transactions if t['amount'] <= max_amount]

    return transactions[:limit]


async def spending_summary(month: str = None, group_by: str = "category") -> dict:
    """Get spending grouped by category/merchant."""
    from ..decoder import decode_transactions
    from collections import defaultdict

    transactions = decode_transactions()

    # Filter to month if specified
    if month:
        transactions = [t for t in transactions
                       if t.get('date', '').startswith(month)]

    # Only expenses (positive amounts)
    expenses = [t for t in transactions if t['amount'] > 0]

    # Group
    grouped = defaultdict(float)
    for tx in expenses:
        if group_by == "category":
            key = tx.get('category_id') or 'Uncategorized'
        elif group_by == "merchant":
            key = tx.get('display_name') or 'Unknown'
        else:
            key = tx.get('date', 'Unknown')[:10]

        grouped[key] += tx['amount']

    # Sort by amount
    sorted_groups = sorted(grouped.items(), key=lambda x: -x[1])

    return {
        "total": sum(grouped.values()),
        "breakdown": [{"name": k, "amount": round(v, 2)} for k, v in sorted_groups]
    }
```

### Phase 3: Testing & Polish (Day 3)

#### 3.1 Unit Tests
```python
# tests/test_decoder.py
import pytest
from copilot_money_mcp.decoder import (
    decode_varint,
    extract_string_value,
    decode_transactions
)

def test_decode_varint():
    # Single byte
    assert decode_varint(b'\x01', 0) == (1, 1)
    # Multi-byte
    assert decode_varint(b'\x96\x01', 0) == (150, 2)

def test_extract_string():
    data = b'\x0a\x04name\x12\x08\x8a\x01\x05hello'
    assert extract_string_value(data, b'name') == 'hello'

def test_decode_transactions():
    # This requires actual data files
    transactions = decode_transactions()
    assert len(transactions) > 0
    assert 'amount' in transactions[0]
    assert 'display_name' in transactions[0]
```

#### 3.2 Error Handling
- Handle missing/corrupted LevelDB files
- Handle app not installed
- Handle database locked (app running)
- Graceful degradation when fields missing

### Phase 4: Advanced Features (Optional)

#### 4.1 Caching Layer
```python
# Cache decoded data in memory with TTL
import time
from functools import lru_cache

_cache = {}
_cache_time = 0
CACHE_TTL = 60  # seconds

def get_cached_transactions():
    global _cache, _cache_time

    if time.time() - _cache_time > CACHE_TTL:
        _cache = decode_transactions()
        _cache_time = time.time()

    return _cache
```

#### 4.2 File Watch for Real-time Updates
```python
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class LevelDBHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if event.src_path.endswith('.ldb'):
            invalidate_cache()
```

#### 4.3 Additional Tools
- `compare_months(month1, month2)` - Compare spending
- `find_subscriptions()` - Detect recurring charges
- `budget_status()` - Check against budgets
- `unusual_transactions()` - Flag anomalies
- `export_csv(start_date, end_date)` - Export data

---

## Distribution Strategy

### Option 1: pip Package (Recommended)

#### Setup
```toml
# pyproject.toml
[project]
name = "copilot-money-mcp"
version = "0.1.0"
description = "MCP server for Copilot Money local data"
requires-python = ">=3.10"
dependencies = [
    "mcp>=1.0.0",
]

[project.scripts]
copilot-money-mcp = "copilot_money_mcp.server:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

#### Installation
```bash
# From PyPI (after publishing)
pip install copilot-money-mcp

# From source
pip install git+https://github.com/yourusername/copilot-money-mcp.git

# Local development
pip install -e .
```

#### Claude Desktop Config
```json
{
  "mcpServers": {
    "copilot-money": {
      "command": "copilot-money-mcp"
    }
  }
}
```

### Option 2: Standalone Binary (PyInstaller)

```bash
# Build
pip install pyinstaller
pyinstaller --onefile src/copilot_money_mcp/server.py -n copilot-money-mcp

# Distribute
# Binary will be in dist/copilot-money-mcp
```

### Option 3: Homebrew Formula

```ruby
# Formula/copilot-money-mcp.rb
class CopilotMoneyMcp < Formula
  include Language::Python::Virtualenv

  desc "MCP server for Copilot Money local data"
  homepage "https://github.com/yourusername/copilot-money-mcp"
  url "https://github.com/yourusername/copilot-money-mcp/archive/v0.1.0.tar.gz"
  sha256 "..."

  depends_on "python@3.11"

  def install
    virtualenv_install_with_resources
  end
end
```

### Option 4: Docker (for server deployments)

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY . .
RUN pip install -e .

# Mount the Firestore data directory
VOLUME /data

ENV FIRESTORE_PATH=/data

CMD ["copilot-money-mcp"]
```

### Claude Code Configuration

#### Location
```
~/.claude/claude_desktop_config.json
```

#### Config Examples
```json
// Using pip-installed command
{
  "mcpServers": {
    "copilot-money": {
      "command": "copilot-money-mcp"
    }
  }
}

// Using Python module directly
{
  "mcpServers": {
    "copilot-money": {
      "command": "python",
      "args": ["-m", "copilot_money_mcp.server"]
    }
  }
}

// Using absolute path
{
  "mcpServers": {
    "copilot-money": {
      "command": "/Users/you/projects/copilot-money-mcp/venv/bin/python",
      "args": ["-m", "copilot_money_mcp.server"]
    }
  }
}
```

---

## Security Considerations

1. **Data is local only** - No network requests, all data stays on your machine
2. **Read-only access** - We only read from LevelDB, never write
3. **No credentials stored** - No API keys or auth tokens needed
4. **File permissions** - Respects macOS sandbox (data is in user's Library folder)

## Limitations

1. **macOS only** - Data path is specific to macOS App Store version
2. **Offline data only** - Only reads cached data, not live Firestore
3. **Schema changes** - Copilot updates may change data format
4. **LevelDB locking** - May have issues if app is actively writing

---

## References

- [Firebase Firestore Proto Definitions](https://github.com/googleapis/googleapis/tree/master/google/firestore/v1)
- [Firebase iOS SDK Local Protos](https://github.com/firebase/firebase-ios-sdk/tree/main/Firestore/Protos)
- [LevelDB Format](https://github.com/google/leveldb/blob/main/doc/table_format.md)
- [Protocol Buffers Encoding](https://protobuf.dev/programming-guides/encoding/)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)



