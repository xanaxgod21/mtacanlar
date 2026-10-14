#pragma once
#include <string>
#include <vector>

#include "../config.hpp"
#include "../../event/event.hpp"
#include "../../network/server.hpp"
#include "../../packet/game/world.hpp"

namespace core::handlers {
// Warns the player when a moderator (or an invisible player) is in the world.
class ModAlertHandler {
public:
    ModAlertHandler(event::Dispatcher& dispatcher, network::Server& server, Config& config);

    ModAlertHandler(const ModAlertHandler&) = delete;
    ModAlertHandler& operator=(const ModAlertHandler&) = delete;
    ModAlertHandler(ModAlertHandler&&) noexcept = delete;
    ModAlertHandler& operator=(ModAlertHandler&&) noexcept = delete;
    ~ModAlertHandler() = default;

    [[nodiscard]] bool is_enabled() const { return enabled_; }
    void set_enabled(bool enabled);

private:
    void on_spawn(const packet::game::OnSpawn& spawn) const;

    event::Dispatcher& dispatcher_;
    network::Server& server_;
    Config& config_;

    bool enabled_{ true };

    std::vector<event::ScopedHandle> handles_;
};
}
