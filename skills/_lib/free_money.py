"""Single source of truth for the Free Money formula.

Imported by per-skill scripts. The same formula appears as prose in
finance/SKILL.md and finance-pulse/SKILL.md so a reader doesn't have to
chase the file; this script is authoritative.
"""


def compute_free_money(
    net_income: float,
    fixed_obligations: float,
    savings_target: float,
    amortized_irregular: float,
    already_spent: float,
) -> float:
    """Return discretionary $ remaining for the month.

    Subtracts every committed/fixed outflow from net income. Negative
    return value means the user is already over budget.
    """
    return (
        net_income
        - fixed_obligations
        - savings_target
        - amortized_irregular
        - already_spent
    )
