package api

import (
	"fmt"
	"math"
	"strings"
)

func normalizeFlow(raw string, amount float64) (string, float64, error) {
	flow := strings.ToLower(strings.TrimSpace(raw))
	if flow == "" {
		if amount > 0 {
			flow = "income"
		} else {
			flow = "expense"
		}
	}
	absAmount := math.Abs(amount)
	switch flow {
	case "income":
		return flow, absAmount, nil
	case "refund":
		return flow, absAmount, nil
	case "expense":
		return flow, -absAmount, nil
	default:
		return "", 0, fmt.Errorf("invalid flow: %s", flow)
	}
}
