#pragma once
#include <chrono>
#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../../event/event.hpp"
#include "../../network/client.hpp"

namespace core::handlers {
// Picks up dropped objects near the local player by sending the same
// ITEM_ACTIVATE_OBJECT_REQUEST the client sends when it walks over a drop.
// Runs whenever the player moves or something is dropped, so it never needs
// its own timer and always runs on the main thread.
class AutoCollectHandler {
public:
    static constexpr float DEFAULT_RANGE{ 2.0f };
    static constexpr float MIN_RANGE{ 1.0f };
    static constexpr float MAX_RANGE{ 5.0f };

    AutoCollectHandler(event::Dispatcher& dispatcher, network::Client& client);

    AutoCollectHandler(const AutoCollectHandler&) = delete;
    AutoCollectHandler& operator=(const AutoCollectHandler&) = delete;
    AutoCollectHandler(AutoCollectHandler&&) noexcept = delete;
    AutoCollectHandler& operator=(AutoCollectHandler&&) noexcept = delete;
    ~AutoCollectHandler() = default;

    [[nodiscard]] bool is_enabled() const { return enabled_; }
    void set_enabled(bool enabled);

    [[nodiscard]] float get_range() const { return range_; }
    // Clamps to [MIN_RANGE, MAX_RANGE] and returns the range actually used.
    float set_range(float range_tiles);

    // Sends pickup requests for drops in range. Returns how many were sent.
    std::size_t collect_nearby();

    // Drops of `item_id` that appear within `window` are never picked up, so
    // items the player drops on purpose are not collected straight back.
    void ignore_drops_of(std::uint16_t item_id, std::chrono::milliseconds window);

private:
    // Requests that get no answer are retried a few times, then given up on so
    // an object the server refuses to hand over is not spammed forever.
    static constexpr auto RETRY_DELAY{ std::chrono::milliseconds{ 1000 } };
    static constexpr int MAX_ATTEMPTS{ 3 };
    static constexpr std::size_t MAX_REQUESTS_PER_PASS{ 4 };

    struct Attempt {
        int count{ 0 };
        std::chrono::steady_clock::time_point last_sent{};
    };

    void setup_handlers();
    template <packet::PacketId Id, typename Func>
    void listen(event::Direction direction, Func&& func);
    void track_new_drop(std::uint16_t item_id);
    void reset();

    event::Dispatcher& dispatcher_;
    network::Client& client_;

    bool enabled_{ false };
    float range_{ DEFAULT_RANGE };
    std::unordered_map<std::uint32_t, Attempt> attempts_;
    std::unordered_map<std::uint16_t, std::chrono::steady_clock::time_point> ignore_until_;
    std::unordered_set<std::uint32_t> ignored_objects_;

    std::vector<event::ScopedHandle> handles_;
};
}
