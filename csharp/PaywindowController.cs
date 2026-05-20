// ============================================================
// Sample controller for NMKR Studio.
// The bridge server calls:
//   GET /v2/GetMidnightPaywindowDetails?reservationid={id}
//   Accept: text/plain
//   Authorization: Bearer <api-key>
// and expects PaywindowData as JSON.
//
// This file is a skeleton — the lookup logic (DB access, status
// checks, auth) is left for you to fill in.
// ============================================================

using Microsoft.AspNetCore.Mvc;
using Nmkr.Midnight.Paywindow.Models;

namespace Nmkr.Midnight.Paywindow.Api;

[ApiController]
[Route("v2")]
public class PaywindowController : ControllerBase
{
    private readonly IPaywindowService _service;

    public PaywindowController(IPaywindowService service)
    {
        _service = service;
    }

    /// <summary>
    /// Returns the data required to mint for a given reservation id.
    /// MUST be authenticated (bridge-server only) — the response
    /// contains the OwnerSeed.
    /// </summary>
    [HttpGet("GetMidnightPaywindowDetails")]
    public async Task<ActionResult<PaywindowData>> Get([FromQuery] string reservationid)
    {
        // TODO: validate the API key / bearer token against an allowlist
        //       (Authorization header), e.g. via an attribute or middleware.

        var data = await _service.GetByIdAsync(reservationid);
        if (data is null)
            return NotFound(new { error = "reservation id unknown" });

        if (data.Status == PaywindowStatus.Consumed)
            return StatusCode(StatusCodes.Status410Gone,
                new { error = "reservation already used" });

        return Ok(data.ToDto());
    }

    /// <summary>
    /// Optional: after a successful mint the bridge server can hit this
    /// endpoint so the reservation cannot be redeemed again.
    /// </summary>
    [HttpPost("ConsumeMidnightPaywindow")]
    public async Task<IActionResult> Consume([FromQuery] string reservationid, [FromBody] ConsumeRequest body)
    {
        // TODO: auth check as above.
        await _service.MarkConsumedAsync(reservationid, body.PaymentTxHash, body.TokenId);
        return NoContent();
    }
}

public class ConsumeRequest
{
    public string PaymentTxHash { get; set; } = "";
    public int TokenId { get; set; }
}

// ----- Service interface + domain entity (you supply the implementation) -----

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
        },
        Recipients = Recipients.Count == 0 ? null : Recipients,
    };
}
