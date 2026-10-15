#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// Pure, I/O free pieces of the license check (see license_client.hpp for the
// HTTP side), kept separate so they can be unit tested.
namespace license {
enum class Status {
    Ok,
    InvalidKey,
    Revoked,
    Expired,
    HwidMismatch,
    BadSignature,
    BadResponse,
    ServerError,
    NetworkError
};

struct Result {
    Status status{ Status::NetworkError };
    std::int64_t expires_at{ 0 };  // Unix seconds, 0 = never expires.
    std::int64_t server_time{ 0 }; // Unix seconds, server clock.
    std::string message;
};

inline constexpr std::size_t HWID_LENGTH{ 32 };
inline constexpr std::size_t NONCE_LENGTH{ 32 };
inline constexpr std::size_t MAX_KEY_LENGTH{ 64 };

[[nodiscard]] std::string to_hex(std::span<const std::byte> data, bool uppercase = false);
// Accepts both cases. std::nullopt on an odd length or a non-hex character.
[[nodiscard]] std::optional<std::vector<std::byte>> from_hex(std::string_view hex);

[[nodiscard]] std::optional<std::array<std::byte, 32>> sha256(std::span<const std::byte> data);

// Removes all whitespace and uppercases, the same way the key server does.
[[nodiscard]] std::string normalize_key(std::string_view key);
// False for keys the server would reject as a malformed request: empty, longer
// than MAX_KEY_LENGTH, or containing anything but printable ASCII (control
// characters, non-UTF-8 bytes from a console code page). Real keys are ASCII.
[[nodiscard]] bool is_well_formed_key(std::string_view normalized_key);

// SHA-256("gtproxy-hwid-v1|" + machine id), first 16 bytes as 32 uppercase hex.
[[nodiscard]] std::optional<std::string> make_hwid(std::string_view machine_id);
// "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX", for showing the HWID to the user.
[[nodiscard]] std::string format_hwid(std::string_view hwid);

// Splits "https://host:port/base/" into { "https://host:port", "/base" }, as
// httplib::Client only takes the scheme, host and port.
[[nodiscard]] std::pair<std::string, std::string> split_server_url(std::string_view url);

// Checks the signed payload of an activation response: the signature, then
// the version, nonce and HWID echoed by the server, then maps the status.
[[nodiscard]] Result verify_response(
    std::string_view payload_hex,
    std::string_view signature_hex,
    std::string_view public_key_hex,
    std::string_view expected_nonce,
    std::string_view expected_hwid
);

// Checks the HTTP status and body of an activation response, then verifies it.
[[nodiscard]] Result process_response(
    int http_status,
    std::string_view body,
    std::string_view public_key_hex,
    std::string_view expected_nonce,
    std::string_view expected_hwid
);

// Statuses that mean the key cannot be used; the others may be temporary.
[[nodiscard]] constexpr bool is_rejection(const Status status)
{
    return status == Status::InvalidKey
        || status == Status::Revoked
        || status == Status::Expired
        || status == Status::HwidMismatch;
}

// Default text for a status, used when the server did not send a message.
[[nodiscard]] std::string_view describe(Status status);
}
