#include "license.hpp"

#include <algorithm>
#include <cctype>
#include <memory>
#include <fmt/format.h>
#include <glaze/glaze.hpp>
#include <openssl/err.h>
#include <openssl/evp.h>

namespace license {
// These structs are reflected by glaze. glaze 6.x on MSVC refuses to reflect a
// type with internal linkage (error C7631), so they are declared at namespace
// scope (external linkage) instead of inside the anonymous namespace below.
// The signed part of an activation response.
struct Payload {
    int v{ 0 };
    std::string status;
    std::string nonce;
    std::string hwid;
    std::int64_t expires_at{ 0 };
    std::int64_t server_time{ 0 };
    std::string message;
};

struct SignedResponse {
    std::string payload;
    std::string signature;
};

struct ErrorResponse {
    std::string error;
};

namespace {
constexpr glz::opts READ_OPTS{ .error_on_unknown_keys = false, .error_on_missing_keys = true };
constexpr std::size_t PUBLIC_KEY_SIZE{ 32 };
constexpr std::size_t SIGNATURE_SIZE{ 64 };
constexpr std::size_t MAX_ERROR_LENGTH{ 200 };

[[nodiscard]] constexpr int hex_value(const char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }

    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }

    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }

    return -1;
}

[[nodiscard]] bool iequals(const std::string_view a, const std::string_view b)
{
    return std::ranges::equal(a, b, [](const char x, const char y) {
        return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
    });
}

[[nodiscard]] std::optional<Status> parse_status(const std::string_view status)
{
    if (status == "ok") {
        return Status::Ok;
    }

    if (status == "invalid_key") {
        return Status::InvalidKey;
    }

    if (status == "revoked") {
        return Status::Revoked;
    }

    if (status == "expired") {
        return Status::Expired;
    }

    if (status == "hwid_mismatch") {
        return Status::HwidMismatch;
    }

    return std::nullopt;
}

[[nodiscard]] Result make_result(const Status status, std::string message = {})
{
    if (message.empty()) {
        message = describe(status);
    }

    return Result{ .status = status, .message = std::move(message) };
}

// Error texts are not signed, so keep only printable ASCII before logging them.
[[nodiscard]] std::string sanitize(const std::string_view text)
{
    std::string clean{};
    for (const char c : text.substr(0, MAX_ERROR_LENGTH)) {
        if (c >= 0x20 && c < 0x7F) {
            clean.push_back(c);
        }
    }

    return clean;
}

[[nodiscard]] bool verify_signature(
    const std::span<const std::byte> message,
    const std::span<const std::byte> signature,
    const std::span<const std::byte> public_key
) {
    if (public_key.size() != PUBLIC_KEY_SIZE || signature.size() != SIGNATURE_SIZE) {
        return false;
    }

    const std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key{
        EVP_PKEY_new_raw_public_key(
            EVP_PKEY_ED25519,
            nullptr,
            reinterpret_cast<const unsigned char*>(public_key.data()),
            public_key.size()
        ),
        &EVP_PKEY_free
    };
    const std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx{ EVP_MD_CTX_new(), &EVP_MD_CTX_free };

    // Ed25519 hashes internally, so no digest is given.
    const bool valid{
        key && ctx
        && EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, key.get()) == 1
        && EVP_DigestVerify(
            ctx.get(),
            reinterpret_cast<const unsigned char*>(signature.data()),
            signature.size(),
            reinterpret_cast<const unsigned char*>(message.data()),
            message.size()
        ) == 1
    };

    if (!valid) {
        // Leave the thread's error queue clean for later TLS calls.
        ERR_clear_error();
    }

    return valid;
}
}

std::string to_hex(const std::span<const std::byte> data, const bool uppercase)
{
    constexpr std::string_view LOWER_DIGITS{ "0123456789abcdef" };
    constexpr std::string_view UPPER_DIGITS{ "0123456789ABCDEF" };
    const auto digits{ uppercase ? UPPER_DIGITS : LOWER_DIGITS };

    std::string hex{};
    hex.reserve(data.size() * 2);
    for (const auto byte : data) {
        const auto value{ std::to_integer<std::uint8_t>(byte) };
        hex.push_back(digits[value >> 4]);
        hex.push_back(digits[value & 0x0F]);
    }

    return hex;
}

std::optional<std::vector<std::byte>> from_hex(const std::string_view hex)
{
    if (hex.size() % 2 != 0) {
        return std::nullopt;
    }

    std::vector<std::byte> data{};
    data.reserve(hex.size() / 2);
    for (std::size_t i{ 0 }; i < hex.size(); i += 2) {
        const int high{ hex_value(hex[i]) };
        const int low{ hex_value(hex[i + 1]) };
        if (high < 0 || low < 0) {
            return std::nullopt;
        }

        data.push_back(static_cast<std::byte>(high << 4 | low));
    }

    return data;
}

std::optional<std::array<std::byte, 32>> sha256(const std::span<const std::byte> data)
{
    std::array<std::byte, 32> digest{};
    unsigned int length{ 0 };
    if (EVP_Digest(
        data.data(),
        data.size(),
        reinterpret_cast<unsigned char*>(digest.data()),
        &length,
        EVP_sha256(),
        nullptr
    ) != 1 || length != digest.size()) {
        return std::nullopt;
    }

    return digest;
}

std::string normalize_key(const std::string_view key)
{
    std::string normalized{};
    normalized.reserve(key.size());
    for (const char c : key) {
        const auto uc{ static_cast<unsigned char>(c) };
        if (!std::isspace(uc)) {
            normalized.push_back(static_cast<char>(std::toupper(uc)));
        }
    }

    return normalized;
}

bool is_well_formed_key(const std::string_view normalized_key)
{
    return !normalized_key.empty()
        && normalized_key.size() <= MAX_KEY_LENGTH
        && std::ranges::all_of(normalized_key, [](const char c) { return c > ' ' && c < 0x7F; });
}

std::optional<std::string> make_hwid(const std::string_view machine_id)
{
    if (machine_id.empty()) {
        return std::nullopt;
    }

    const std::string input{ fmt::format("gtproxy-hwid-v1|{}", machine_id) };
    const auto digest{ sha256(std::as_bytes(std::span{ input })) };
    if (!digest) {
        return std::nullopt;
    }

    return to_hex(std::span{ *digest }.first(HWID_LENGTH / 2), true);
}

std::string format_hwid(const std::string_view hwid)
{
    std::string formatted{};
    for (std::size_t i{ 0 }; i < hwid.size(); ++i) {
        if (i > 0 && i % 8 == 0) {
            formatted.push_back('-');
        }

        formatted.push_back(hwid[i]);
    }

    return formatted;
}

std::pair<std::string, std::string> split_server_url(const std::string_view url)
{
    const auto scheme_end{ url.find("://") };
    const auto path_begin{ url.find('/', scheme_end == std::string_view::npos ? 0 : scheme_end + 3) };
    if (path_begin == std::string_view::npos) {
        return { std::string{ url }, std::string{} };
    }

    auto base_path{ url.substr(path_begin) };
    while (!base_path.empty() && base_path.back() == '/') {
        base_path.remove_suffix(1);
    }

    return { std::string{ url.substr(0, path_begin) }, std::string{ base_path } };
}

Result verify_response(
    const std::string_view payload_hex,
    const std::string_view signature_hex,
    const std::string_view public_key_hex,
    const std::string_view expected_nonce,
    const std::string_view expected_hwid
) {
    const auto payload{ from_hex(payload_hex) };
    const auto signature{ from_hex(signature_hex) };
    if (!payload || payload->empty() || !signature) {
        return make_result(Status::ServerError, "Malformed response from the license server");
    }

    const auto public_key{ from_hex(public_key_hex) };
    if (!public_key || !verify_signature(*payload, *signature, *public_key)) {
        return make_result(Status::BadSignature);
    }

    Payload data{};
    const std::string json{ reinterpret_cast<const char*>(payload->data()), payload->size() };
    if (glz::read<READ_OPTS>(data, json)) {
        return make_result(Status::BadResponse);
    }

    if (data.v != 1 || data.nonce != expected_nonce || !iequals(data.hwid, expected_hwid)) {
        return make_result(Status::BadResponse);
    }

    const auto status{ parse_status(data.status) };
    if (!status) {
        return make_result(Status::BadResponse);
    }

    Result result{ make_result(*status, std::move(data.message)) };
    result.expires_at = data.expires_at;
    result.server_time = data.server_time;

    if (result.status == Status::Ok && result.expires_at != 0 && result.expires_at <= result.server_time) {
        result.status = Status::Expired;
        result.message = describe(Status::Expired);
    }

    return result;
}

Result process_response(
    const int http_status,
    const std::string_view body,
    const std::string_view public_key_hex,
    const std::string_view expected_nonce,
    const std::string_view expected_hwid
) {
    const std::string buffer{ body };

    if (http_status != 200) {
        ErrorResponse error{};
        if (!glz::read<READ_OPTS>(error, buffer) && !error.error.empty()) {
            return make_result(
                Status::ServerError,
                fmt::format("License server error (HTTP {}): {}", http_status, sanitize(error.error))
            );
        }

        return make_result(Status::ServerError, fmt::format("License server error (HTTP {})", http_status));
    }

    SignedResponse response{};
    if (glz::read<READ_OPTS>(response, buffer)) {
        return make_result(Status::ServerError, "Malformed response from the license server");
    }

    return verify_response(response.payload, response.signature, public_key_hex, expected_nonce, expected_hwid);
}

std::string_view describe(const Status status)
{
    switch (status) {
    case Status::Ok:
        return "License is valid";
    case Status::InvalidKey:
        return "Invalid license key";
    case Status::Revoked:
        return "License key has been revoked";
    case Status::Expired:
        return "License key has expired";
    case Status::HwidMismatch:
        return "License key is already activated on another computer";
    case Status::BadSignature:
        return "License server response has an invalid signature";
    case Status::BadResponse:
        return "Unexpected response from the license server";
    case Status::ServerError:
        return "License server error";
    case Status::NetworkError:
        return "Could not reach the license server";
    }

    return "Unknown license status";
}
}
