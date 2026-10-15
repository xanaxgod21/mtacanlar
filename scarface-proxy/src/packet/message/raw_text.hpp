#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <vector>

#include "../packet_types.hpp"

namespace packet::message {
// Builds a text packet byte for byte ([message type][text][NUL]). Use it for text
// that must go out exactly as the client formats it, e.g. "action|drop\n|itemID|242"
// with its empty-key line, which TextParse would reformat.
[[nodiscard]] inline std::vector<std::byte> make_raw_text(const NetMessageType type, const std::string_view text)
{
    const auto type_value{ static_cast<std::uint32_t>(type) };

    std::vector<std::byte> data(sizeof(type_value) + text.size() + 1);
    std::memcpy(data.data(), &type_value, sizeof(type_value));
    std::memcpy(data.data() + sizeof(type_value), text.data(), text.size());
    data.back() = std::byte{ 0 };
    return data;
}
}
