#pragma once
#include <optional>
#include <string>
#include <string_view>

#include "license.hpp"

namespace license {
// The OS machine ID the HWID is derived from; std::nullopt if unavailable.
[[nodiscard]] std::optional<std::string> read_machine_id();

// 16 random bytes from the CSPRNG as 32 lowercase hex characters.
[[nodiscard]] std::optional<std::string> generate_nonce();

class LicenseClient {
public:
    LicenseClient(std::string server_url, std::string public_key, std::string hwid);

    [[nodiscard]] const std::string& get_hwid() const { return hwid_; }

    // Activates the key on the license server, or re-validates it. Blocks for
    // up to a few seconds and is safe to call from any thread.
    [[nodiscard]] Result activate(std::string_view key) const;

private:
    std::string server_url_;
    std::string public_key_;
    std::string hwid_;
};
}
