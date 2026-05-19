// ============================================================
// DTOs for the paywindow lookup API.
//
// The paywindow frontend calls the Node bridge at
//   POST /api/build-mint   { id, buyerShieldedAddress }
// The bridge in turn fetches the PaywindowData record for that id
// from NMKR Studio:
//   GET {NMKR_STUDIO_URL}/paywindow/{id}
//
// SECURITY: OwnerSeed is highly sensitive. The NMKR Studio backend
// must NEVER expose this object to a browser — only to the
// authenticated paywindow bridge server.
// ============================================================

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Nmkr.Midnight.Paywindow.Models;

/// <summary>
/// Everything the paywindow bridge needs for a given paywindow id
/// in order to build an atomic mint transaction on Midnight.
/// </summary>
public class PaywindowData
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    /// <summary>
    /// Collection owner seed (32-byte hex or mnemonic, whichever
    /// nmkr-midnight-api expects). Used to sign the mint transaction.
    /// MUST stay server-side — never forward this to the browser.
    /// </summary>
    [JsonPropertyName("ownerSeed")]
    public string OwnerSeed { get; set; } = "";

    /// <summary>
    /// Bech32m address of the deployed NFT contract to mint into.
    /// </summary>
    [JsonPropertyName("contractAddress")]
    public string ContractAddress { get; set; } = "";

    [JsonPropertyName("nft")]
    public PaywindowNft Nft { get; set; } = new();

    /// <summary>
    /// Optional. When set, NIGHT outputs to the listed recipients are
    /// appended to the same transaction (atomic buy &amp; mint).
    /// </summary>
    [JsonPropertyName("payment")]
    public PaywindowPayment? Payment { get; set; }
}

public class PaywindowNft
{
    /// <summary>Display name of the NFT — shown after the reveal.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>URI / link to the full off-chain metadata.</summary>
    [JsonPropertyName("uri")]
    public string Uri { get; set; } = "";

    /// <summary>Image URL (https or ipfs).</summary>
    [JsonPropertyName("image")]
    public string Image { get; set; } = "";

    /// <summary>Image MIME type, e.g. "image/png" or "image/svg+xml".</summary>
    [JsonPropertyName("mediaType")]
    public string MediaType { get; set; } = "";

    /// <summary>Description — revealed only after a successful mint.</summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    /// <summary>
    /// Arbitrary extra metadata (rarity, edition, properties, …).
    /// Shown when the user clicks the metadata reveal button.
    /// </summary>
    [JsonPropertyName("attributes")]
    public Dictionary<string, object>? Attributes { get; set; }
}

public class PaywindowPayment
{
    /// <summary>Total price in NIGHT (display only; actual split lives in Recipients).</summary>
    [JsonPropertyName("priceNight")]
    public decimal PriceNight { get; set; }

    [JsonPropertyName("recipients")]
    public List<PaywindowRecipient> Recipients { get; set; } = new();
}

public class PaywindowRecipient
{
    /// <summary>Bech32m unshielded NIGHT recipient address.</summary>
    [JsonPropertyName("address")]
    public string Address { get; set; } = "";

    /// <summary>Amount in atomic NIGHT units (1 NIGHT = 1_000_000), as a string to preserve BigInt range.</summary>
    [JsonPropertyName("amountRaw")]
    public string AmountRaw { get; set; } = "";
}
