// ============================================================
// Beispiel-Controller fuer NMKR Studio.
// Der Bridge-Server schickt:
//   GET /paywindow/{id}
//   Authorization: Bearer <api-key>
// und erwartet PaywindowData als JSON.
//
// Diese Datei ist ein Geruest — die Lookup-Logik (DB-Abfrage,
// Status-Checks, Auth) musst du noch fuellen.
// ============================================================

using Microsoft.AspNetCore.Mvc;
using Nmkr.Midnight.Paywindow.Models;

namespace Nmkr.Midnight.Paywindow.Api;

[ApiController]
[Route("paywindow")]
public class PaywindowController : ControllerBase
{
    private readonly IPaywindowService _service;

    public PaywindowController(IPaywindowService service)
    {
        _service = service;
    }

    /// <summary>
    /// Liefert die zum Minten benoetigten Daten zu einer Paywindow-Id.
    /// MUSS authentifiziert sein (nur fuer den Bridge-Server zugaenglich) —
    /// die Response enthaelt den OwnerSeed.
    /// </summary>
    [HttpGet("{id}")]
    public async Task<ActionResult<PaywindowData>> Get(string id)
    {
        // TODO: API-Key / Bearer-Token gegen Allowlist pruefen
        //       (Authorization-Header), z.B. via Attribute oder Middleware.

        var data = await _service.GetByIdAsync(id);
        if (data is null)
            return NotFound(new { error = "paywindow id unknown" });

        if (data.Status == PaywindowStatus.Consumed)
            return StatusCode(StatusCodes.Status410Gone,
                new { error = "paywindow already used" });

        return Ok(data.ToDto());
    }

    /// <summary>
    /// Optional: Bridge-Server koennte nach erfolgreichem Mint hier
    /// Bescheid geben, damit die Paywindow nicht erneut eingeloest werden kann.
    /// </summary>
    [HttpPost("{id}/consume")]
    public async Task<IActionResult> Consume(string id, [FromBody] ConsumeRequest body)
    {
        // TODO: Auth-Check wie oben.
        await _service.MarkConsumedAsync(id, body.PaymentTxHash, body.TokenId);
        return NoContent();
    }
}

public class ConsumeRequest
{
    public string PaymentTxHash { get; set; } = "";
    public int TokenId { get; set; }
}

// ----- Service-Interface + Domain-Modell (du fuellst die Implementierung) -----

public interface IPaywindowService
{
    Task<PaywindowEntity?> GetByIdAsync(string id);
    Task MarkConsumedAsync(string id, string paymentTxHash, int tokenId);
}

public enum PaywindowStatus { Open, Consumed, Expired }

public class PaywindowEntity
{
    public string Id { get; set; } = "";
    public PaywindowStatus Status { get; set; }
    public string OwnerSeed { get; set; } = "";
    public string ContractAddress { get; set; } = "";
    public string Name { get; set; } = "";
    public string Uri { get; set; } = "";
    public string Image { get; set; } = "";
    public string MediaType { get; set; } = "";
    public string Description { get; set; } = "";
    public Dictionary<string, object>? Attributes { get; set; }
    public decimal PriceNight { get; set; }
    public List<PaywindowRecipient> Recipients { get; set; } = new();

    public PaywindowData ToDto() => new()
    {
        Id = Id,
        OwnerSeed = OwnerSeed,
        ContractAddress = ContractAddress,
        Nft = new PaywindowNft
        {
            Name = Name,
            Uri = Uri,
            Image = Image,
            MediaType = MediaType,
            Description = Description,
            Attributes = Attributes,
        },
        Payment = Recipients.Count == 0 ? null : new PaywindowPayment
        {
            PriceNight = PriceNight,
            Recipients = Recipients,
        },
    };
}
