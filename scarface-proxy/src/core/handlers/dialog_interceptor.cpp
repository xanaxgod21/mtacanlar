#include "dialog_interceptor.hpp"

#include <algorithm>
#include <spdlog/spdlog.h>

namespace core::handlers {
DialogInterceptor::DialogInterceptor(event::Dispatcher& dispatcher, std::shared_ptr<Scheduler> scheduler)
    : dispatcher_{ dispatcher }
    , scheduler_{ std::move(scheduler) }
{
    constexpr auto type{ event::packet_event_type(packet::PacketId::OnDialogRequest) };
    handles_.emplace_back(
        dispatcher_,
        type,
        dispatcher_.append_listener(type, [this](const event::Event& event) { on_dialog_request(event); })
    );
}

DialogInterceptor::Id DialogInterceptor::expect(
    std::string dialog_name,
    Handler handler,
    const std::chrono::milliseconds timeout,
    TimeoutHandler timeout_handler
) {
    const Id id{ next_id_++ };
    expectations_.push_back(Expectation{ id, std::move(dialog_name), std::move(handler), std::move(timeout_handler) });
    run_later(timeout, [this, id] { on_timeout(id); });
    return id;
}

void DialogInterceptor::cancel(const Id id)
{
    std::erase_if(expectations_, [id](const Expectation& e) { return e.id == id; });
}

bool DialogInterceptor::is_pending(const Id id) const
{
    return std::ranges::any_of(expectations_, [id](const Expectation& e) { return e.id == id; });
}

void DialogInterceptor::run_later(const std::chrono::milliseconds delay, std::function<void()> callback) const
{
    // Scheduler callbacks run on a worker thread; hop back to the main thread
    // before touching any state or sending packets.
    const auto scheduler{ scheduler_.get() };
    scheduler_->schedule_delayed(
        [scheduler, callback = std::move(callback)] { scheduler->post_to_main_thread(callback); },
        delay,
        "dialog"
    );
}

void DialogInterceptor::on_dialog_request(const event::Event& event)
{
    if (expectations_.empty()) {
        return;
    }

    const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::OnDialogRequest>*>(&event) };
    if (!evt || evt->direction != event::Direction::ClientBound) {
        return;
    }

    const auto pkt{ evt->get<packet::game::OnDialogRequest>() };
    if (!pkt) {
        return;
    }

    const auto dialog{ packet::game::parse_dialog(pkt->dialog) };

    // Handlers may register new expectations, so walk a snapshot of the ids.
    std::vector<Id> ids{};
    for (const auto& expectation : expectations_) {
        if (expectation.dialog_name == dialog.name) {
            ids.push_back(expectation.id);
        }
    }

    for (const Id id : ids) {
        const auto it{ std::ranges::find_if(expectations_, [id](const Expectation& e) { return e.id == id; }) };
        if (it == expectations_.end()) {
            continue;
        }

        const auto handler{ it->handler };
        if (!handler(dialog)) {
            continue;
        }

        cancel(id);
        evt->cancel();
        return;
    }
}

void DialogInterceptor::on_timeout(const Id id)
{
    const auto it{ std::ranges::find_if(expectations_, [id](const Expectation& e) { return e.id == id; }) };
    if (it == expectations_.end()) {
        return;
    }

    const auto timeout_handler{ std::move(it->on_timeout) };
    expectations_.erase(it);

    if (timeout_handler) {
        timeout_handler();
    }
}
}
