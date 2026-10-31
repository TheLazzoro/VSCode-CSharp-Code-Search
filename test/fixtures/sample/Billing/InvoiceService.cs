using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Acme.Billing;

/// <summary>Creates and totals invoices.</summary>
public record Invoice(string Id, decimal Amount);

public interface IInvoiceStore
{
    Task<Invoice?> FindAsync(string id);
    int Count { get; }
}

public enum InvoiceState
{
    Draft,
    Sent = 2,
    Paid,
}

public delegate void InvoiceHandler(object sender, Invoice invoice);

public class InvoiceService<TStore>(TStore store) : IDisposable where TStore : IInvoiceStore
{
    private const string DefaultCurrency = "DKK";
    private readonly List<Invoice> _pending = new(), _archived = new();

    public event EventHandler? Changed;
    public string Title { get; set; } = "Invoices";
    public Invoice this[int index] => _pending[index];

    public InvoiceService() : this(default!) { }
    ~InvoiceService() { }

    public static InvoiceService<TStore> operator +(InvoiceService<TStore> left, Invoice right) => left;
    public static implicit operator bool(InvoiceService<TStore> service) => service is not null;

    void IDisposable.Dispose() => _pending.Clear();

    public async Task<decimal> GetUserTotalAsync<TKey>(string userName, int top = 3, params int[] skipped)
    {
        var total = 0m; int seen = 0, ignored = 1;
        for (int attempt = 0; attempt < top; attempt++) { }
        foreach (var invoice in _pending) { total += invoice.Amount; }
        foreach (var (key, value) in new Dictionary<string, int>()) { seen += value; }
        using var scope = OpenScope();
        using (var nested = OpenScope()) { }

        try
        {
            Changed?.Invoke(this, EventArgs.Empty);
        }
        catch (InvalidOperationException failure) when (failure.Data.Count > 0)
        {
            throw;
        }

        if (await store.FindAsync(userName) is Invoice found && found is { Amount: var foundAmount })
        {
            total += foundAmount;
        }
        int.TryParse("1", out var parsed);
        var (first, second) = (1, 2);
        var doubled = from entry in _archived let amount = entry.Amount * 2 select amount;
        Func<int, int> increment = delta => delta + 1;
        Func<int, int, int> add = (int augend, int addend) => augend + addend;

        int Square(int operand) => operand * operand;

        // Blåbærgrød: the identifiers after a non-ASCII comment keep their columns.
        /* æøå */ var rødgrød = Square(parsed + first + second);
        return total + rødgrød + increment(seen) + add(ignored, 1);
    }

    private static IDisposable OpenScope() => null!;
}

public struct Money
{
    public decimal Value;
}
