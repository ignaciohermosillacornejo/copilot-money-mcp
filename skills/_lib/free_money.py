"""Single source of truth for the Free Money formula.

Reference implementation — the same formula is reproduced as prose in
finance/SKILL.md and finance-pulse/SKILL.md, which is what runs at
invocation time. This file is the canonical version for maintainers:
when the formula changes, update here first and then sync the SKILL.md
prose to match.
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
