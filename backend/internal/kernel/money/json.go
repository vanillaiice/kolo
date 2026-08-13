package money

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// wireMoney is the JSON shape of an amount. Keeping the currency alongside the
// integer means a value read back from the sync protocol or a document store
// can never be reinterpreted in the wrong currency.
type wireMoney struct {
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
}

// MarshalJSON implements json.Marshaler. An amount with an undefined currency
// is an error rather than something to serialise, so a partially constructed
// value cannot escape into storage or onto the wire.
func (m Money) MarshalJSON() ([]byte, error) {
	if !m.Valid() {
		return nil, ErrUndefinedCurrency
	}
	return json.Marshal(wireMoney{Amount: m.minor, Currency: m.currency.code})
}

// UnmarshalJSON implements json.Unmarshaler.
//
// A null literal leaves the value untouched, following the encoding/json
// convention. An absent amount in a payload therefore stays absent rather than
// becoming a decode failure, and the invalid zero value it leaves behind is
// caught by the first operation that tries to use it.
func (m *Money) UnmarshalJSON(data []byte) error {
	if bytes.Equal(data, []byte("null")) {
		return nil
	}

	var wire wireMoney
	if err := json.Unmarshal(data, &wire); err != nil {
		return fmt.Errorf("money: decoding amount: %w", err)
	}
	currency, err := ByCode(wire.Currency)
	if err != nil {
		return err
	}
	m.minor = wire.Amount
	m.currency = currency
	return nil
}
