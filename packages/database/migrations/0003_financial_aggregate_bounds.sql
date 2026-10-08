CREATE OR REPLACE FUNCTION kfin_assert_financial_aggregate_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id UUID;
  aggregate_account_id UUID;
  affected_on DATE;
  month_start DATE;
  month_end DATE;
  current_income NUMERIC;
  current_expense NUMERIC;
  current_balance NUMERIC;
  monthly_income NUMERIC;
  monthly_expense NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    owner_id := OLD.user_id;
    aggregate_account_id := OLD.account_id;
    affected_on := OLD.occurred_on;
  ELSE
    owner_id := NEW.user_id;
    aggregate_account_id := NEW.account_id;
    affected_on := NEW.occurred_on;
  END IF;

  SELECT posted_current_income_minor, posted_current_expense_minor, current_balance_minor
  INTO current_income, current_expense, current_balance
  FROM financial_current_balances
  WHERE user_id = owner_id AND account_id = aggregate_account_id;

  IF current_income < 0 OR current_income > 9223372036854775807
     OR current_expense < 0 OR current_expense > 9223372036854775807
     OR current_balance < -9223372036854775808 OR current_balance > 9223372036854775807 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'financial current aggregate is outside the supported bigint range';
  END IF;

  month_start := date_trunc('month', affected_on)::date;
  month_end := (month_start + INTERVAL '1 month')::date;
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'income'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'expense'), 0)
  INTO monthly_income, monthly_expense
  FROM transactions
  WHERE user_id = owner_id AND account_id = aggregate_account_id
    AND status = 'posted'
    AND occurred_on >= month_start AND occurred_on < month_end;

  IF monthly_income < 0 OR monthly_income > 9223372036854775807
     OR monthly_expense < 0 OR monthly_expense > 9223372036854775807
     OR monthly_income - monthly_expense < -9223372036854775808
     OR monthly_income - monthly_expense > 9223372036854775807 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'financial monthly aggregate is outside the supported bigint range';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transactions_financial_aggregate_bounds_trg
AFTER INSERT OR UPDATE OR DELETE ON transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION kfin_assert_financial_aggregate_bounds();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM financial_current_balances
    WHERE posted_current_income_minor > 9223372036854775807
       OR posted_current_expense_minor > 9223372036854775807
       OR current_balance_minor < -9223372036854775808
       OR current_balance_minor > 9223372036854775807
  ) OR EXISTS (
    SELECT 1
    FROM transactions
    WHERE status = 'posted'
    GROUP BY user_id, account_id, date_trunc('month', occurred_on)
    HAVING COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'income'), 0) > 9223372036854775807
       OR COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'expense'), 0) > 9223372036854775807
       OR COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'income'), 0)
          - COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'expense'), 0)
          NOT BETWEEN -9223372036854775808 AND 9223372036854775807
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'existing financial aggregate is outside the supported bigint range';
  END IF;
END;
$$;
