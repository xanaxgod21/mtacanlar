#pragma once
#include <algorithm>
#include <charconv>
#include <optional>
#include <string>
#include <vector>
#include <fmt/format.h>

#include "../command.hpp"
#include "../../item/item_database.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/message/chat.hpp"
#include "../../player/player.hpp"
#include "../../world/object_map.hpp"
#include "../../world/tile_map.hpp"
#include "../../world/world.hpp"

namespace command {
class DebugCommand final : public ICommand {
public:
    [[nodiscard]] std::string_view name() const override { return "debug"; }
    [[nodiscard]] std::string description() const override { return "Show debug information about player, world, tile, or object"; }

    Result execute(const Context& ctx) override
    {
        if (ctx.args.empty()) {
            send_log(ctx, "Usage: /debug <player|world|tile|object>");
            return Result::Failed;
        }

        const std::string& sub_cmd{ ctx.args[0] };

        if (sub_cmd == "player") {
            const auto& world{ world::World::instance() };
            const auto& players = world.get_players();

            if (ctx.args.size() < 2) {
                send_log(ctx, fmt::format("Total Players: {}", players.size()));
                for (const auto& [net_id, player] : players) {
                    send_log(
                        ctx,
                        fmt::format(
                            "[{}] {} ({}, {})",
                            net_id,
                            player->name(),
                            player->position().x,
                            player->position().y
                        )
                    );
                }

                return Result::Success;
            }

            int32_t net_id{ 0 };
            const auto& arg{ ctx.args[1] };
            if (
                auto [ptr, ec]{ std::from_chars(arg.data(), arg.data() + arg.size(), net_id) };
                ec != std::errc{}
            ) {
                send_log(ctx, "Invalid NetID format.");
                return Result::Failed;
            }

            if (const auto player{ world.get_player(net_id).lock() }) {
                send_log(ctx, fmt::format("Player Info (NetID: {}):", net_id));
                send_log(ctx, fmt::format("Name: {} (User: {})", player->name(), player->user_id()));
                send_log(ctx, fmt::format("Pos: {}, {}", player->position().x, player->position().y));
                send_log(ctx, fmt::format("Country: {}", player->country_code()));
                send_log(ctx, fmt::format("Mod: {}, SuperMod: {}", player->mod_state(), player->supermod_state()));
                return Result::Success;
            }

            send_log(ctx, fmt::format("Player with NetID {} not found.", net_id));
            return Result::Failed;
        }

        if (sub_cmd == "world") {
            auto& world{ world::World::instance() };
            auto& tile_map{ world.get_tile_map() };
            auto& object_map{ world.get_object_map() };

            send_log(ctx, "World Info:");
            send_log(ctx, fmt::format("Version: {}", world.get_version()));
            send_log(ctx, fmt::format("Size: {}x{}", tile_map.get_size().x, tile_map.get_size().y));
            send_log(ctx, fmt::format("Tiles: {}", tile_map.get_tiles().size()));
            send_log(ctx, fmt::format("Objects: {}", object_map.get_objects().size()));
            send_log(ctx, fmt::format("Player Count: {}", world.get_players().size()));
            return Result::Success;
        }

        if (sub_cmd == "tile") {
            return show_tile(ctx);
        }

        if (sub_cmd == "object") {
            return show_objects(ctx);
        }

        send_log(ctx, fmt::format("Unknown debug target: {}", sub_cmd));
        return Result::Failed;
    }

private:
    static constexpr std::size_t MAX_LISTED_OBJECTS{ 20 };

    template <typename T>
    [[nodiscard]] static std::optional<T> parse_number(const std::string& arg)
    {
        T value{};
        if (
            auto [ptr, ec]{ std::from_chars(arg.data(), arg.data() + arg.size(), value) };
            ec != std::errc{} || ptr != arg.data() + arg.size()
        ) {
            return std::nullopt;
        }

        return value;
    }

    [[nodiscard]] static std::string item_label(const std::uint32_t item_id)
    {
        if (const auto item{ item::ItemDatabase::instance().get_item(item_id) }) {
            return fmt::format("{} ({})", item->item_name, item_id);
        }

        return fmt::format("{}", item_id);
    }

    static Result show_tile(const Context& ctx)
    {
        if (ctx.args.size() < 3) {
            send_log(ctx, "Usage: /debug tile <x> <y>");
            return Result::InvalidArguments;
        }

        const auto x{ parse_number<int>(ctx.args[1]) };
        const auto y{ parse_number<int>(ctx.args[2]) };
        if (!x || !y) {
            send_log(ctx, "Invalid tile coordinates.");
            return Result::InvalidArguments;
        }

        const auto& tile_map{ world::World::instance().get_tile_map() };
        const auto& size{ tile_map.get_size() };
        const auto& tiles{ tile_map.get_tiles() };
        const auto index{ static_cast<std::size_t>(*x) + static_cast<std::size_t>(*y) * static_cast<std::size_t>(size.x) };
        if (*x < 0 || *y < 0 || *x >= size.x || *y >= size.y || index >= tiles.size()) {
            send_log(ctx, fmt::format("Tile ({}, {}) is outside the world ({}x{}).", *x, *y, size.x, size.y));
            return Result::Failed;
        }

        const auto& tile{ tiles[index] };
        send_log(ctx, fmt::format("Tile Info ({}, {}):", *x, *y));
        send_log(ctx, fmt::format("Foreground: {}", item_label(tile.foreground)));
        send_log(ctx, fmt::format("Background: {}", item_label(tile.background)));
        send_log(ctx, fmt::format("Parent: {}, Lock parent: {}", tile.parent_tile, tile.lock_parent_tile));
        send_log(ctx, fmt::format("Flags: 0x{:04X}", static_cast<std::uint16_t>(tile.flag)));
        return Result::Success;
    }

    static Result show_objects(const Context& ctx)
    {
        const auto& objects{ world::World::instance().get_object_map().get_objects() };

        if (ctx.args.size() >= 2) {
            const auto object_id{ parse_number<std::uint32_t>(ctx.args[1]) };
            if (!object_id) {
                send_log(ctx, "Invalid object ID format.");
                return Result::InvalidArguments;
            }

            const auto it{ std::ranges::find_if(objects, [&](const world::Object& obj) {
                return obj.object_id == *object_id;
            }) };

            if (it == objects.end()) {
                send_log(ctx, fmt::format("Object with ID {} not found.", *object_id));
                return Result::Failed;
            }

            send_log(ctx, fmt::format("Object Info (ID: {}):", it->object_id));
            send_log(ctx, fmt::format("Item: {} x{}", item_label(it->item_id), it->amount));
            send_log(ctx, fmt::format("Pos: {:.1f}, {:.1f} (tile {}, {})", it->pos.x, it->pos.y,
                static_cast<int>(it->pos.x) / 32, static_cast<int>(it->pos.y) / 32));
            send_log(ctx, fmt::format("Flags: {}", it->flags));
            return Result::Success;
        }

        send_log(ctx, fmt::format("Total Objects: {}", objects.size()));
        for (std::size_t i{ 0 }; i < objects.size() && i < MAX_LISTED_OBJECTS; ++i) {
            const auto& obj{ objects[i] };
            send_log(ctx, fmt::format("[{}] {} x{} ({:.0f}, {:.0f})", obj.object_id, item_label(obj.item_id), obj.amount, obj.pos.x, obj.pos.y));
        }

        if (objects.size() > MAX_LISTED_OBJECTS) {
            send_log(ctx, fmt::format("...and {} more. Use /debug object <id> for details.", objects.size() - MAX_LISTED_OBJECTS));
        }

        return Result::Success;
    }

    // Helper to send log messages to the player (TODO: move to a common utility)
    static void send_log(const Context& ctx, const std::string& msg)
    {
        packet::message::Log log_pkt{};
        log_pkt.msg = msg;
        packet::PacketHelper::write(log_pkt, ctx.server);
    }
};
}
