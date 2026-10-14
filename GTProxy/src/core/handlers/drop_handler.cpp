#include "drop_handler.hpp"

#include <charconv>
#include <fmt/format.h>
#include <spdlog/spdlog.h>

#include "../../item/lock_conversion.hpp"
#include "../../packet/game/inventory.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/message/raw_text.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
namespace {
template <typename T>
std::optional<T> parse_number(const std::string_view text)
{
    T value{};
    if (auto [ptr, ec]{ std::from_chars(text.data(), text.data() + text.size(), value) }; ec != std::errc{} || ptr != text.data() + text.size()) {
        return std::nullopt;
    }

    return value;
}
}

DropHandler::DropHandler(
    network::Client& client,
    network::Server& server,
    DialogInterceptor& dialogs,
    AutoCollectHandler& auto_collect
)
    : client_{ client }
    , server_{ server }
    , dialogs_{ dialogs }
    , auto_collect_{ auto_collect }
{

}

DropHandler::Result DropHandler::request_drop(const std::uint16_t item_id, const int amount, const std::string& item_name)
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

    auto& inventory{ player::Inventory::instance() };
    const auto plan{ item::locks::plan_conversion(item_id, amount, inventory) };
    if (!plan) {
        start_drop(item_id, amount, item_name);
        return Result::Sent;
    }

    for (int i{ 0 }; i < plan->count; ++i) {
        packet::game::ItemActivateRequest activate{};
        activate.item_id = plan->source_item;
        if (!packet::PacketHelper::write(activate, client_)) {
            return Result::NotConnected;
        }
    }

    // Assume it worked; the drop dialog reports the real count and corrects it.
    inventory.add(plan->source_item, -plan->count);
    inventory.add(item_id, plan->count * item::locks::TIER_RATIO);

    spdlog::info("Drop: shattering {} x item {} before dropping {} x item {}", plan->count, plan->source_item, amount, item_id);
    dialogs_.run_later(CONVERSION_DELAY, [this, item_id, amount, item_name] { start_drop(item_id, amount, item_name); });
    return Result::Converting;
}

void DropHandler::start_drop(const std::uint16_t item_id, const int amount, const std::string& item_name)
{
    if (!send_text(fmt::format("action|drop\n|itemID|{}", item_id))) {
        send_log(fmt::format("`4Drop failed: ``lost connection while dropping {}", item_name));
        return;
    }

    dialogs_.expect(
        "drop_item",
        [this, item_id, amount, item_name](const packet::game::DialogInfo& dialog) {
            return on_drop_dialog(dialog, item_id, amount, item_name);
        },
        DIALOG_TIMEOUT,
        [this, item_name] {
            send_log(fmt::format("`4Drop failed: ``the server did not ask how many {} to drop. Do you have any?", item_name));
        }
    );

    spdlog::info("Drop: requested drop of {} x item {}", amount, item_id);
}

bool DropHandler::on_drop_dialog(
    const packet::game::DialogInfo& dialog,
    const std::uint16_t item_id,
    const int amount,
    const std::string& item_name
) {
    const auto dialog_item{ dialog.get_embed_data("itemID") };
    if (!dialog_item || parse_number<std::uint16_t>(*dialog_item) != item_id) {
        // Another item's drop dialog, e.g. one the player opened by hand.
        return false;
    }

    auto& inventory{ player::Inventory::instance() };

    // The amount box defaults to everything the player holds: the real count.
    if (const auto input{ dialog.get_text_input("count") }) {
        if (const auto owned{ parse_number<int>(*input) }) {
            inventory.set(item_id, *owned);
            if (*owned < amount) {
                send_log(fmt::format("`4Not enough: ``you have `w{}`` {}, not dropping {}", *owned, item_name, amount));
                return true;
            }
        }
    }

    auto_collect_.ignore_drops_of(item_id, AUTO_COLLECT_IGNORE_WINDOW);

    const auto reply{ packet::game::make_dialog_return(dialog, { { "count", std::to_string(amount) } }) };
    if (!send_text(reply)) {
        send_log(fmt::format("`4Drop failed: ``lost connection while dropping {}", item_name));
        return true;
    }

    inventory.add(item_id, -amount);
    spdlog::info("Drop: answered drop dialog for item {} with count {}", item_id, amount);
    return true;
}

bool DropHandler::send_text(const std::string_view text) const
{
    return client_.write(packet::message::make_raw_text(packet::NET_MESSAGE_GENERIC_TEXT, text));
}

void DropHandler::send_log(const std::string& msg) const
{
    packet::message::Log log_pkt{};
    log_pkt.msg = msg;
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}
}
