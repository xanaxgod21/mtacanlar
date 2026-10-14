#include "event_bindings.hpp"

namespace scripting::bindings {
void EventBindings::bind(sol::state& lua)
{
    auto event_table{ lua.create_table() };

    // Accepts the "side:Name" aliases used in scripts/AGENTS.md:
    //   "client:Connect"/"server:Disconnect" -> ClientConnect/ServerDisconnect
    //   "client:SendToClient" -> ClientBoundPacket, "server:SendToServer" -> ServerBoundPacket
    //   "server:OnSpawn" (any other name) -> OnSpawn
    auto normalize_event_name = [](const std::string& event_name) -> std::string {
        const bool is_server{ event_name.starts_with("server:") };
        if (!is_server && !event_name.starts_with("client:")) {
            return event_name;
        }

        const std::string name{ event_name.substr(event_name.find(':') + 1) };
        if (name == "Connect" || name == "Disconnect") {
            return (is_server ? "Server" : "Client") + name;
        }

        if (name == "SendToClient") {
            return "ClientBoundPacket";
        }

        if (name == "SendToServer") {
            return "ServerBoundPacket";
        }

        return name;
    };

    event_table.set_function("on", sol::overload(
        [this, normalize_event_name](const std::string& event_name, sol::protected_function callback) {
            return bridge_.register_callback(normalize_event_name(event_name), std::move(callback));
        },
        [this, normalize_event_name](const std::string& event_name, sol::protected_function callback, const int priority) {
            return bridge_.register_callback(
                normalize_event_name(event_name),
                std::move(callback),
                static_cast<int8_t>(priority)
                );
            }
    ));

    event_table.set_function("off", [this](const std::size_t handle) {
        return bridge_.unregister_callback(handle);
    });

    lua["event"] = event_table;
}
}
