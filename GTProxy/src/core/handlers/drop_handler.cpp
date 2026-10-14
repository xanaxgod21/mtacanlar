#include "drop_handler.hpp"

#include <charconv>
#include <fmt/format.h>
#include <magic_enum/magic_enum.hpp>
#include <spdlog/spdlog.h>

#include "../../packet/game/dialog.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../utils/byte_stream.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
DropHandler::DropHandler(
    event::Dispatcher& dispatcher,
    network::Client& client,
    network::Server& server,
    std::shared_ptr<Scheduler> scheduler,
    AutoCollectHandler& auto_collect
)
    : dispatcher_{ dispatcher }
    , client_{ client }
    , server_{ server }
    , scheduler_{ std::move(scheduler) }
    , auto_collect_{ auto_collect }
{
    constexpr auto dialog_type{ event::packet_event_type(packet::PacketId::OnDialogRequest) };
    handles_.emplace_back(
        dispatcher_,
        dialog_type,
        dispatcher_.append_listener(dialog_type, [this](const event::Event& event) { on_dialog_request(event); })
    );
}

DropHandler::Result DropHandler::request_drop(const std::uint16_t item_id, const int amount, std::string item_name)
{
    if (amount < 1 || amount > MAX_AMOUNT) {
        return Result::InvalidAmount;
    }

    if (!client_.is_connected()) {
        return Result::NotConnected;
    }

    if (world::World::instance().get_local_net_id() < 0) {
        return Result::NotInWorld;
    }

    if (!send_generic_text(fmt::format("action|drop\n|itemID|{}", item_id))) {
        return Result::NotConnected;
    }

    const auto sequence{ next_sequence_++ };
    pending_[item_id] = PendingDrop{ amount, std::move(item_name), sequence };

    // The timer fires on a scheduler worker; hop back to the main thread
    // before touching any state or sending packets.
    const auto scheduler{ scheduler_.get() };
    scheduler_->schedule_delayed(
        [this, scheduler, item_id, sequence] {
            scheduler->post_to_main_thread([this, item_id, sequence] { on_timeout(item_id, sequence); });
        },
        DIALOG_TIMEOUT,
        "drop"
    );

    spdlog::info("Drop: requested drop of {} x item {}", amount, item_id);
    return Result::Sent;
}

void DropHandler::on_dialog_request(const event::Event& event)
{
    if (pending_.empty()) {
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
    if (dialog.name != "drop_item") {
        return;
    }

    const auto item_id_str{ dialog.get_embed_data("itemID") };
    if (!item_id_str) {
        return;
    }

    std::uint16_t item_id{ 0 };
    if (
        auto [ptr, ec]{ std::from_chars(item_id_str->data(), item_id_str->data() + item_id_str->size(), item_id) };
        ec != std::errc{}
    ) {
        return;
    }

    const auto it{ pending_.find(item_id) };
    if (it == pending_.end()) {
        // A drop the player started by hand: let the dialog through.
        return;
    }

    const auto drop{ std::move(it->second) };
    pending_.erase(it);

    // Hide the dialog from the player and answer it ourselves.
    evt->cancel();

    auto_collect_.ignore_drops_of(item_id, AUTO_COLLECT_IGNORE_WINDOW);

    const auto reply{ packet::game::make_dialog_return(dialog, { { "count", std::to_string(drop.amount) } }) };
    if (!send_generic_text(reply)) {
        send_log(fmt::format("`4Drop failed: ``lost connection while dropping {}", drop.item_name));
        return;
    }

    spdlog::info("Drop: answered drop dialog for item {} with count {}", item_id, drop.amount);
}

void DropHandler::on_timeout(const std::uint16_t item_id, const std::uint64_t sequence)
{
    const auto it{ pending_.find(item_id) };
    if (it == pending_.end() || it->second.sequence != sequence) {
        return;
    }

    send_log(fmt::format(
        "`4Drop failed: ``the server did not ask how many {} to drop. Do you have any?",
        it->second.item_name
    ));
    pending_.erase(it);
}

bool DropHandler::send_generic_text(const std::string_view text) const
{
    // Built by hand rather than through TextParse so the text goes out exactly
    // as the client formats it (e.g. the "\n|itemID|" line with an empty key).
    utils::ByteStream stream{};
    stream.write(magic_enum::enum_underlying(packet::NET_MESSAGE_GENERIC_TEXT));
    stream.write(std::string{ text }, false);

    auto data{ stream.get_data() };
    data.push_back(static_cast<std::byte>(0x00));
    return client_.write(data);
}

void DropHandler::send_log(const std::string& msg) const
{
    packet::message::Log log_pkt{};
    log_pkt.msg = msg;
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}
}
