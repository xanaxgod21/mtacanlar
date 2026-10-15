#pragma once
#include <string>
#include <vector>

#include "../config.hpp"
#include "../../event/event.hpp"

namespace core::handlers {
// Reads the Growtopia version and protocol out of the client's own login packet
// every time it connects, so the proxy follows whatever version the installed
// game client reports. Routine Growtopia version bumps (e.g. 5.39 -> 5.40) then
// need no config edit and no rebuild: the client updates itself and the proxy
// picks the new version straight out of its login. The detected values are
// logged and written back to config.json so it never shows a stale version.
//
// Only packet structure changes (new opcodes/fields) still need a new build;
// a plain version bump does not.
class VersionHandler {
public:
    VersionHandler(event::Dispatcher& dispatcher, Config& config);

    VersionHandler(const VersionHandler&) = delete;
    VersionHandler& operator=(const VersionHandler&) = delete;
    VersionHandler(VersionHandler&&) noexcept = delete;
    VersionHandler& operator=(VersionHandler&&) noexcept = delete;
    ~VersionHandler() = default;

    [[nodiscard]] const std::string& get_game_version() const { return game_version_; }
    [[nodiscard]] int get_protocol() const { return protocol_; }

private:
    event::Dispatcher& dispatcher_;
    Config& config_;

    std::string game_version_;
    int protocol_{ 0 };

    std::vector<event::ScopedHandle> handles_;
};
}
