#pragma once
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "auto_collect_handler.hpp"
#include "../scheduler.hpp"
#include "../../event/event.hpp"
#include "../../network/client.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// Drops items without the "how many?" dialog: sends the same "action|drop"
// the client sends, hides the server's drop_item dialog and answers it right
// away with the requested amount.
class DropHandler {
public:
    static constexpr int MAX_AMOUNT{ 200 };

    enum class Result {
        Sent,
        InvalidAmount,
        NotConnected,
        NotInWorld,
    };

    DropHandler(
        event::Dispatcher& dispatcher,
        network::Client& client,
        network::Server& server,
        std::shared_ptr<Scheduler> scheduler,
        AutoCollectHandler& auto_collect
    );

    DropHandler(const DropHandler&) = delete;
    DropHandler& operator=(const DropHandler&) = delete;
    DropHandler(DropHandler&&) noexcept = delete;
    DropHandler& operator=(DropHandler&&) noexcept = delete;
    ~DropHandler() = default;

    Result request_drop(std::uint16_t item_id, int amount, std::string item_name);

private:
    // How long to wait for the server's drop dialog before giving up.
    static constexpr auto DIALOG_TIMEOUT{ std::chrono::milliseconds{ 3000 } };
    // How long auto collect leaves fresh drops of the dropped item alone.
    static constexpr auto AUTO_COLLECT_IGNORE_WINDOW{ std::chrono::milliseconds{ 5000 } };

    struct PendingDrop {
        int amount{ 0 };
        std::string item_name;
        std::uint64_t sequence{ 0 };
    };

    void on_dialog_request(const event::Event& event);
    void on_timeout(std::uint16_t item_id, std::uint64_t sequence);
    bool send_generic_text(std::string_view text) const;
    void send_log(const std::string& msg) const;

    event::Dispatcher& dispatcher_;
    network::Client& client_;
    network::Server& server_;
    std::shared_ptr<Scheduler> scheduler_;
    AutoCollectHandler& auto_collect_;

    std::unordered_map<std::uint16_t, PendingDrop> pending_;
    std::uint64_t next_sequence_{ 1 };

    std::vector<event::ScopedHandle> handles_;
};
}
