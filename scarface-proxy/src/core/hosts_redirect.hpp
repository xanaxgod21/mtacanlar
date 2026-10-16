#pragma once

namespace core {
// Points Growtopia's login hostnames at 127.0.0.1 by editing the Windows hosts
// file, so the game runs through this proxy with no manual setup by the user.
// It adds its own marked block on construction and removes it again on
// restore()/destruction, and first clears any block a previous crash left
// behind. Windows only; it relies on the administrator rights the proxy already
// needs to bind port 443 (the exe ships an elevation manifest).
class HostsRedirect {
public:
    HostsRedirect();
    ~HostsRedirect();

    HostsRedirect(const HostsRedirect&) = delete;
    HostsRedirect& operator=(const HostsRedirect&) = delete;
    HostsRedirect(HostsRedirect&&) = delete;
    HostsRedirect& operator=(HostsRedirect&&) = delete;

    // Removes the block this added. Idempotent and safe to call more than once
    // (e.g. from a console-close handler and then again from the destructor).
    void restore();

    [[nodiscard]] bool active() const { return active_; }

private:
    bool active_{ false };
};
}
