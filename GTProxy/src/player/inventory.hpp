#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <span>
#include <unordered_map>

#include "../utils/byte_stream.hpp"

namespace player {
// The local player's inventory, as last reported by the server and kept up to
// date from what the proxy can observe (pickups, drops, drop dialogs).
class Inventory {
public:
    static constexpr int MAX_STACK{ 200 };

    static Inventory& instance()
    {
        static Inventory inventory;
        return inventory;
    }

    // Parses the SendInventoryState payload:
    // [u8 version][u32 slot count][u16 item count] then per item [u16 id][u8 amount][u8 flags].
    bool parse(const std::span<const std::byte> data)
    {
        constexpr std::size_t header_size{ sizeof(std::uint8_t) + sizeof(std::uint32_t) + sizeof(std::uint16_t) };
        constexpr std::size_t item_size{ sizeof(std::uint16_t) + 2 * sizeof(std::uint8_t) };
        if (data.size() < header_size) {
            return false;
        }

        utils::ByteStream<> bs{ data.data(), data.size() };

        std::uint8_t version{ 0 };
        std::uint32_t slot_count{ 0 };
        std::uint16_t item_count{ 0 };
        bs.read(version);
        bs.read(slot_count);
        bs.read(item_count);

        if (data.size() < header_size + item_count * item_size) {
            return false;
        }

        std::unordered_map<std::uint16_t, int> items{};
        for (std::uint16_t i{ 0 }; i < item_count; ++i) {
            std::uint16_t item_id{ 0 };
            std::uint8_t amount{ 0 };
            std::uint8_t flags{ 0 };
            bs.read(item_id);
            bs.read(amount);
            bs.read(flags);
            items[item_id] += amount;
        }

        items_ = std::move(items);
        slot_count_ = slot_count;
        known_ = true;
        return true;
    }

    [[nodiscard]] bool is_known() const { return known_; }
    [[nodiscard]] std::uint32_t get_slot_count() const { return slot_count_; }
    [[nodiscard]] const std::unordered_map<std::uint16_t, int>& get_items() const { return items_; }

    [[nodiscard]] int get(const std::uint16_t item_id) const
    {
        const auto it{ items_.find(item_id) };
        return it != items_.end() ? it->second : 0;
    }

    void set(const std::uint16_t item_id, const int amount)
    {
        if (amount <= 0) {
            items_.erase(item_id);
            return;
        }

        items_[item_id] = std::min(amount, MAX_STACK);
    }

    void add(const std::uint16_t item_id, const int delta)
    {
        set(item_id, get(item_id) + delta);
    }

    void clear()
    {
        items_.clear();
        slot_count_ = 0;
        known_ = false;
    }

private:
    std::unordered_map<std::uint16_t, int> items_;
    std::uint32_t slot_count_{ 0 };
    bool known_{ false };
};
}
