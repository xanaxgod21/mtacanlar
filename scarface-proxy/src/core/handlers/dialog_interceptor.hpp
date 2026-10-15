#pragma once
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "../scheduler.hpp"
#include "../../event/event.hpp"
#include "../../packet/game/dialog.hpp"

namespace core::handlers {
// Lets features answer a server dialog on the player's behalf: after sending a
// request that makes the server open a dialog, register an expectation for it.
// A dialog an expectation takes is hidden from the player.
class DialogInterceptor {
public:
    using Id = std::uint64_t;
    // Return true to take the dialog (it is hidden and the expectation ends),
    // false if it is not the dialog this expectation is waiting for.
    using Handler = std::function<bool(const packet::game::DialogInfo& dialog)>;
    using TimeoutHandler = std::function<void()>;

    DialogInterceptor(event::Dispatcher& dispatcher, std::shared_ptr<Scheduler> scheduler);

    DialogInterceptor(const DialogInterceptor&) = delete;
    DialogInterceptor& operator=(const DialogInterceptor&) = delete;
    DialogInterceptor(DialogInterceptor&&) noexcept = delete;
    DialogInterceptor& operator=(DialogInterceptor&&) noexcept = delete;
    ~DialogInterceptor() = default;

    // Waits up to `timeout` for a dialog named `dialog_name` that `handler` takes.
    Id expect(std::string dialog_name, Handler handler, std::chrono::milliseconds timeout, TimeoutHandler timeout_handler);
    void cancel(Id id);
    [[nodiscard]] bool is_pending(Id id) const;

    // Runs `callback` on the main thread after `delay`.
    void run_later(std::chrono::milliseconds delay, std::function<void()> callback) const;

private:
    struct Expectation {
        Id id{ 0 };
        std::string dialog_name;
        Handler handler;
        TimeoutHandler on_timeout;
    };

    void on_dialog_request(const event::Event& event);
    void on_timeout(Id id);

    event::Dispatcher& dispatcher_;
    std::shared_ptr<Scheduler> scheduler_;

    std::vector<Expectation> expectations_;
    Id next_id_{ 1 };

    std::vector<event::ScopedHandle> handles_;
};
}
