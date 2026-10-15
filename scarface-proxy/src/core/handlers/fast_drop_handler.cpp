#include "fast_drop_handler.hpp"

#include <algorithm>
#include <charconv>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>

#include <spdlog/spdlog.h>

#include "../../packet/game/dialog.hpp"
#include "../../packet/message/raw_text.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../player/inventory.hpp"

namespace core::handlers {
namespace {
    constexpr auto dialog_event_type{ event::packet_event_type(packet::PacketId::OnDialogRequest) };

    std::optional<int> parse_int(const std::string_view text)
    {
        int value{};
        if (
            auto [ptr, ec]{ std::from_chars(text.data(), text.data() + text.size(), value) };
            ec != std::errc{} || ptr != text.data() + text.size()
        ) {
            return std::nullopt;
        }

        return value;
    }
}

FastDropHandler::FastDropHandler(event::Dispatcher& dispatcher, network::Client& client, Config& config)
    : dispatcher_{ dispatcher }
    , client_{ client }
    , config_{ config }
{
    handle_ = event::ScopedHandle{
        dispatcher_,
        dialog_event_type,
        dispatcher_.append_listener(dialog_event_type, [this](const event::Event& e) { on_dialog(e); })
    };
}

void FastDropHandler::set_enabled(const bool enabled)
{
    config_.get_feature_config().fast_drop = enabled;
    std::ignore = config_.save();
}

void FastDropHandler::set_amount(const int amount)
{
    config_.get_feature_config().fast_drop_amount = std::max(0, amount);
    std::ignore = config_.save();
}

void FastDropHandler::on_dialog(const event::Event& event)
{
    if (!is_enabled()) {
        return;
    }

    const auto* evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::OnDialogRequest>*>(&event) };
    if (!evt || evt->direction != event::Direction::ClientBound) {
        return;
    }

    const auto pkt{ evt->get<packet::game::OnDialogRequest>() };
    if (!pkt) {
        return;
    }

    const auto dialog{ packet::game::parse_dialog(pkt->dialog) };
    if (dialog.name != "drop_item") {
        return;
    }

    // The count box defaults to everything the player holds.
    int owned{ player::Inventory::MAX_STACK };
    if (const auto input{ dialog.get_text_input("count") }) {
        if (const auto parsed{ parse_int(*input) }) {
            owned = *parsed;
        }
    }

    if (owned <= 0) {
        // Nothing to drop: let the dialog show so the player sees it.
        return;
    }

    const int wanted{ get_amount() };
    const int amount{ wanted > 0 ? std::min(wanted, owned) : owned };

    const auto reply{ packet::game::make_dialog_return(dialog, { { "count", std::to_string(amount) } }) };
    if (!client_.write(packet::message::make_raw_text(packet::NET_MESSAGE_GENERIC_TEXT, reply))) {
        return;
    }

    // Answered on the player's behalf: hide the dialog.
    evt->cancel();
    spdlog::info("Fast drop: auto-dropped {} of item in drop_item dialog", amount);
}
}
