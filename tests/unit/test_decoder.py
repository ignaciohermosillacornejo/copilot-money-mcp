"""
Unit tests for LevelDB/Protobuf decoder functions.
"""

import struct

import pytest

from copilot_money_mcp.core.decoder import (
    decode_varint,
    extract_boolean_value,
    extract_double_value,
    extract_string_value,
)


class TestDecodeVarint:
    """Tests for varint decoding."""

    def test_decode_single_byte_varint(self) -> None:
        """Test decoding single byte varint."""
        # 1 encoded as varint
        result, pos = decode_varint(b"\x01", 0)
        assert result == 1
        assert pos == 1

    def test_decode_multi_byte_varint(self) -> None:
        """Test decoding multi-byte varint."""
        # 150 encoded as varint (0x96 0x01)
        result, pos = decode_varint(b"\x96\x01", 0)
        assert result == 150
        assert pos == 2

    def test_decode_varint_with_offset(self) -> None:
        """Test decoding varint starting at an offset."""
        data = b"\x00\x00\x96\x01\x00"
        result, pos = decode_varint(data, 2)
        assert result == 150
        assert pos == 4

    def test_decode_varint_large_number(self) -> None:
        """Test decoding larger varint values."""
        # 16384 encoded as varint (0x80 0x80 0x01)
        result, pos = decode_varint(b"\x80\x80\x01", 0)
        assert result == 16384
        assert pos == 3


class TestExtractStringValue:
    """Tests for string value extraction."""

    def test_extract_simple_string(self) -> None:
        """Test extracting a simple string value."""
        # Field name "amount" followed by string value tag and "hello"
        data = b"\x0a\x06amount\x12\x08\x8a\x01\x05hello"
        result = extract_string_value(data, b"amount")
        assert result == "hello"

    def test_extract_string_returns_none_when_field_not_found(self) -> None:
        """Test that None is returned when field is not found."""
        data = b"\x0a\x04name\x12\x08\x8a\x01\x04test"
        result = extract_string_value(data, b"missing")
        assert result is None

    def test_extract_string_with_special_characters(self) -> None:
        """Test extracting strings with special characters."""
        # String with spaces and punctuation
        test_str = "Test & Co."
        str_bytes = test_str.encode("utf-8")
        data = b"\x0a\x04name\x12\x10\x8a\x01" + bytes([len(str_bytes)]) + str_bytes
        result = extract_string_value(data, b"name")
        assert result == test_str

    def test_extract_string_handles_invalid_utf8(self) -> None:
        """Test that invalid UTF-8 is handled gracefully."""
        # Invalid UTF-8 sequence
        data = b"\x0a\x04name\x12\x08\x8a\x01\x04\xff\xfe\xfd\xfc"
        result = extract_string_value(data, b"name")
        # Should return None for invalid UTF-8
        assert result is None


# Note: Double and boolean extraction are tested via integration tests with real data
# Synthetic protobuf data is complex to construct correctly
