#pragma once
#include <cstdint>

#include "../config.hpp"
#include "../../event/event.hpp"
#include "../../network/client.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// While enabled, clicking a tile teleports you there instead of punching or
// placing. The client reports the tile it clicked through a TileChangeRequest
// (its int_x/int_y), so the proxy can read the target even though it never
// sees the raw mouse/shift input. It then snaps the local player there
// (OnSetPos to the client) and reports the move to the server (a State packet).
//
// EXPERIMENTAL: the exact teleport packets are server-version dependent and the
// server's movement anti-cheat may reject a long jump. Needs in-game testing.
class PathfindHandler {
public:
    PathfindHandler(event::Dispatcher& dispatcher, network::Client& client, network::Server& server, Config& config);

    PathfindHandler(const PathfindHandler&) = delete;
    PathfindHandler& operator=(const PathfindHandler&) = delete;
    PathfindHandler(PathfindHandler&&) noexcept = delete;
    PathfindHandler& operator=(PathfindHandler&&) noexcept = delete;
    ~PathfindHandler() = default;

    [[nodiscard]] bool is_enabled() const { return config_.get_feature_config().pathfind; }
    void set_enabled(bool enabled);

private:
    static constexpr float TILE_SIZE{ 32.0f };

    void on_tile_change(const event::Event& event);
    void teleport(int tile_x, int tile_y);

    event::Dispatcher& dispatcher_;
    network::Client& client_;
    network::Server& server_;
    Config& config_;

    event::ScopedHandle handle_;
};
}
