#include "roulette_handler.hpp"

#include <fmt/format.h>
#include <spdlog/spdlog.h>

#include "../../packet/game/message.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../utils/roulette.hpp"

namespace core::handlers {
RouletteHandler::RouletteHandler(event::Dispatcher& dispatcher, network::Server& server)
    : dispatcher_{ dispatcher }
    , server_{ server }
{
    listen<packet::PacketId::OnTalkBubble, packet::game::OnTalkBubble>();
    listen<packet::PacketId::OnConsoleMessage, packet::game::OnConsoleMessage>();
}

template <packet::PacketId Id, typename Packet>
void RouletteHandler::listen()
{
    constexpr auto type{ event::packet_event_type(Id) };
    handles_.emplace_back(
        dispatcher_,
        type,
        dispatcher_.append_listener(type, [this](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<Id>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            if (const auto pkt{ evt->template get<Packet>() }) {
                on_message(pkt->text, packet::game::variant_delay(pkt->game_packet));
            }
        })
    );
}

void RouletteHandler::on_message(const std::string_view text, const std::int32_t delay)
{
    const auto spin{ utils::roulette::parse_spin_message(text) };
    if (!spin) {
        return;
    }

    spdlog::info("Roulette: {} spun {} (display delay {} ms)", spin->spinner, spin->number, delay);

    if (!enabled_ || delay <= 0) {
        return;
    }

    const auto now{ std::chrono::steady_clock::now() };
    auto key{ fmt::format("{}|{}", spin->spinner, spin->number) };
    if (key == last_spin_key_ && now - last_spin_time_ < DUPLICATE_WINDOW) {
        return;
    }

    last_spin_key_ = std::move(key);
    last_spin_time_ = now;

    const auto number{ fmt::format("{}{}``", spin->color_code, spin->number) };

    packet::message::Log log{};
    log.msg = fmt::format("`9[Spin] ```w{}`` got {} `o({:.1f}s early)``", spin->spinner, number, delay / 1000.0);
    send_to_player(log);

    packet::game::OnTextOverlay overlay{};
    overlay.text = fmt::format("`w{}`` got {}", spin->spinner, number);
    send_to_player(overlay);
}

void RouletteHandler::send_to_player(packet::IPacket& packet) const
{
    std::ignore = packet::PacketHelper::write(packet, server_);
}
}
