#include "fun_facts_handler.hpp"

#include <array>
#include <string>
#include <string_view>
#include <tuple>

#include <fmt/format.h>

#include "../branding.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/packet_helper.hpp"

namespace core::handlers {
namespace {
    constexpr std::array<std::string_view, 10> FUN_FACTS{
        "The first Growtopia world ever made was called \"START\".",
        "A Diamond Lock is worth 100 World Locks, and a Blue Gem Lock 100 Diamond Locks.",
        "World Locks are the main currency of Growtopia's player economy.",
        "Growtopia was released on January 15, 2013.",
        "Punching a block does not always break it: harder blocks need more hits.",
        "Magplant 5000 can store and auto-plant a single seed type.",
        "The rarest items in the game usually come from limited seasonal events.",
        "Every world in Growtopia is 100 tiles wide and 60 tiles tall.",
        "Growtopia was created by Seth Robinson and Mike Hommel.",
        "Scarface Proxy sits between your game and the server, so these tips are shown only to you.",
    };
}

FunFactsHandler::FunFactsHandler(std::shared_ptr<Scheduler> scheduler, network::Server& server, Config& config)
    : scheduler_{ std::move(scheduler) }
    , server_{ server }
    , config_{ config }
{
    if (is_enabled()) {
        start();
    }
}

FunFactsHandler::~FunFactsHandler()
{
    stop();
}

void FunFactsHandler::set_enabled(const bool enabled)
{
    config_.get_feature_config().fun_facts = enabled;
    std::ignore = config_.save();

    if (enabled) {
        start();
    }
    else {
        stop();
    }
}

void FunFactsHandler::start()
{
    if (task_id_ != INVALID_TASK_ID) {
        return;
    }

    // Scheduler callbacks run on a worker thread; ENet is not thread-safe, so
    // hop back to the main thread before sending the packet.
    Scheduler* const scheduler{ scheduler_.get() };
    task_id_ = scheduler_->schedule_periodic(
        [this, scheduler] { scheduler->post_to_main_thread([this] { tick(); }); },
        INTERVAL,
        TASK_TAG,
        TaskPriority::Low,
        INITIAL_DELAY
    );
}

void FunFactsHandler::stop()
{
    if (task_id_ == INVALID_TASK_ID) {
        return;
    }

    scheduler_->cancel_by_tag(TASK_TAG);
    task_id_ = INVALID_TASK_ID;
}

void FunFactsHandler::tick()
{
    const std::string_view fact{ FUN_FACTS[next_index_ % FUN_FACTS.size()] };
    ++next_index_;

    packet::message::Log log_pkt{};
    log_pkt.msg = fmt::format("{}`oFun fact: ``{}", core::branding::LOG_PREFIX, fact);
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}
}
