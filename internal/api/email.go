package api

import (
	"crypto/tls"
	"fmt"
	"net/smtp"
	"os"
	"strconv"
	"strings"
)

type smtpConfig struct {
	host     string
	port     int
	user     string
	password string
	from     string
	fromName string
}

func loadSMTPConfig() (smtpConfig, error) {
	port, err := strconv.Atoi(strings.TrimSpace(os.Getenv("SMTP_PORT")))
	if err != nil || port == 0 {
		return smtpConfig{}, fmt.Errorf("invalid SMTP_PORT")
	}
	cfg := smtpConfig{
		host:     strings.TrimSpace(os.Getenv("SMTP_HOST")),
		port:     port,
		user:     strings.TrimSpace(os.Getenv("SMTP_USER")),
		password: strings.TrimSpace(os.Getenv("SMTP_PASS")),
		from:     strings.TrimSpace(os.Getenv("SMTP_FROM")),
		fromName: strings.TrimSpace(os.Getenv("SMTP_FROM_NAME")),
	}
	if cfg.fromName == "" {
		cfg.fromName = "ExpenseLog"
	}
	if cfg.host == "" || cfg.user == "" || cfg.password == "" || cfg.from == "" {
		return smtpConfig{}, fmt.Errorf("missing SMTP config")
	}
	return cfg, nil
}

func sendResetCodeEmail(toEmail, code string) error {
	cfg, err := loadSMTPConfig()
	if err != nil {
		return err
	}
	fromHeader := cfg.from
	if cfg.fromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", cfg.fromName, cfg.from)
	}
	subject := "ExpenseLog - Codigo de recuperacion"
	body := fmt.Sprintf("Hola,\n\nTu codigo de recuperacion de ExpenseLog es: %s\n\nEste codigo expira en 15 minutos.\nSi no pediste este codigo, podes ignorar este mensaje.\n\nGracias,\nEquipo ExpenseLog\n", code)
	msg := strings.Join([]string{
		"From: " + fromHeader,
		"To: " + toEmail,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	addr := fmt.Sprintf("%s:%d", cfg.host, cfg.port)
	auth := smtp.PlainAuth("", cfg.user, cfg.password, cfg.host)

	if cfg.port == 465 {
		tlsCfg := &tls.Config{ServerName: cfg.host}
		conn, err := tls.Dial("tcp", addr, tlsCfg)
		if err != nil {
			return err
		}
		defer conn.Close()
		client, err := smtp.NewClient(conn, cfg.host)
		if err != nil {
			return err
		}
		defer client.Close()
		if err := client.Auth(auth); err != nil {
			return err
		}
		if err := client.Mail(cfg.from); err != nil {
			return err
		}
		if err := client.Rcpt(toEmail); err != nil {
			return err
		}
		writer, err := client.Data()
		if err != nil {
			return err
		}
		if _, err := writer.Write([]byte(msg)); err != nil {
			return err
		}
		return writer.Close()
	}

	return smtp.SendMail(addr, auth, cfg.from, []string{toEmail}, []byte(msg))
}
